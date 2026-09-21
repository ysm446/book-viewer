"""重い処理のジョブキュー(単一ワーカーで順次処理)。

文字起こし(transcribe)・章立てと要約(structure)・本文検索の索引(index)を 1 件ずつ直列に行う。
GPU(YomiToku・llama-server)を取り合わないように、すべてこのキュー経由にする。
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

from . import embedding, llm_server, progress, search, structure, transcribe
from .db import connect

KINDS = ("transcribe", "structure", "index")

_lock = threading.Lock()
_cond = threading.Condition(_lock)
_pending: list[dict] = []
_current: dict | None = None
_recent: list[dict] = []
_cancel_ids: set[str] = set()
_worker_started = False


class NotFound(LookupError):
    """積もうとした本が索引に無い。"""


def _title(root: Path, work_id: str) -> str:
    with connect(root) as conn:
        row = conn.execute("SELECT title FROM works WHERE id = ?", (work_id,)).fetchone()
    if row is None:
        raise NotFound("本が見つかりません")
    return row["title"]


def is_busy(work_id: str) -> bool:
    """その本のジョブが待機中か実行中か(本フォルダを動かす操作の前に確かめる)。"""
    with _lock:
        if _current is not None and _current["work_id"] == work_id:
            return True
        return any(j["work_id"] == work_id for j in _pending)


def _ensure_worker() -> None:
    global _worker_started
    with _lock:
        if _worker_started:
            return
        _worker_started = True
    threading.Thread(target=_worker, daemon=True).start()


def enqueue(
    root: str,
    work_id: str,
    kind: str,
    *,
    pages: list[int] | None = None,
    force: bool = False,
    engine: str = "yomitoku",
    extra: dict | None = None,
) -> dict:
    """ジョブを積む。同じ本・同じ種類のジョブが待機中か実行中なら積まない。

    - transcribe: 文字起こし(pages 省略時は未処理の全ページ、force で作り直し。engine を使う)
    - structure: 章立てと要約(force で章立てから作り直し)
    - index: 本文検索の索引(extra に server_path / models_dir)
    """
    if kind not in KINDS:
        raise ValueError(f"未対応のジョブです: {kind}")
    # DB の読み込みはロックの外で(DB が混んでいるときに snapshot() まで待たせない)。
    title = _title(Path(root), work_id)
    with _cond:
        busy = {(j["work_id"], j["kind"]) for j in _pending}
        if _current:
            busy.add((_current["work_id"], _current["kind"]))
        if (work_id, kind) not in busy:
            _pending.append(
                {
                    "work_id": work_id,
                    "root": root,
                    "title": title,
                    "kind": kind,
                    "pages": pages,
                    "force": force,
                    "engine": engine,
                    "extra": extra or {},
                }
            )
            _cond.notify()
    _ensure_worker()
    return snapshot()


def cancel(work_id: str) -> dict:
    with _cond:
        _pending[:] = [j for j in _pending if j["work_id"] != work_id]
        # 実行中の場合のみ中断フラグを立てる(次のページ・まとまりの境界で中断)。
        # 待機中だった場合に立てると、消化されずに残った ID が
        # 次回同じ本を積んだときにジョブを黙って握り潰す。
        if _current is not None and _current["work_id"] == work_id:
            _cancel_ids.add(work_id)
    return snapshot()


def clear() -> dict:
    with _cond:
        _pending.clear()
        if _current:
            _cancel_ids.add(_current["work_id"])
    return snapshot()


def snapshot() -> dict:
    with _lock:
        current = None
        if _current:
            p = progress.get_progress(_current["work_id"]) or {}
            started = _current.get("started_at")
            current = {
                "work_id": _current["work_id"],
                "title": _current["title"],
                "kind": _current["kind"],
                "current": p.get("current", 0),
                "total": p.get("total", 0),
                "phase": p.get("phase", "running"),
                "elapsed": round(time.time() - started) if started else 0,
            }
        return {
            "current": current,
            "pending": [
                {"work_id": j["work_id"], "title": j["title"], "kind": j["kind"]} for j in _pending
            ],
            "recent": list(_recent[-12:]),
        }


def _run(job: dict) -> None:
    root = Path(job["root"])
    work_id = job["work_id"]
    st = llm_server.status()
    base_url = st["base_url"] if st["running"] else None
    cancel_check = lambda: work_id in _cancel_ids  # noqa: E731
    if job["kind"] == "transcribe":
        # YomiToku は LLM を使わないので、モデル未読み込みでも動く。
        transcribe.transcribe_pages(
            root,
            work_id,
            base_url,
            job.get("pages"),
            engine=job.get("engine", "yomitoku"),
            force=job.get("force", False),
            cancel_check=cancel_check,
        )
    elif job["kind"] == "structure":
        if not base_url:
            raise RuntimeError("モデルが読み込まれていません。")
        structure.run(
            root,
            work_id,
            base_url,
            redo=job.get("force", False),
            ctx_size=st.get("ctx_size"),
            cancel_check=cancel_check,
        )
    elif job["kind"] == "index":
        extra = job.get("extra") or {}
        embedding.build_index(
            root, work_id, extra.get("server_path"), extra.get("models_dir"), cancel_check=cancel_check
        )


def _worker() -> None:
    global _current
    while True:
        with _cond:
            while not _pending:
                _cond.wait()
            job = _pending.pop(0)
            if job["work_id"] in _cancel_ids:
                _cancel_ids.discard(job["work_id"])
                continue
            job["started_at"] = time.time()
            _current = job

        status, error = "done", None
        try:
            _run(job)
        except progress.Cancelled:
            status = "canceled"
        except Exception as e:  # noqa: BLE001 - ワーカーは落とさない
            status, error = "error", str(e)

        # 本文や要約が変わったので、書名検索の索引を更新する(途中で止めた分も含む)。
        if job["kind"] in ("transcribe", "structure"):
            try:
                with connect(Path(job["root"])) as conn:
                    search.update_index(conn, Path(job["root"]), job["work_id"])
                    conn.commit()
            except Exception:  # noqa: BLE001 - 索引の更新失敗でワーカーは落とさない
                pass

        with _lock:
            _recent.append(
                {
                    "work_id": job["work_id"],
                    "title": job["title"],
                    "kind": job["kind"],
                    "status": status,
                    "error": error,
                }
            )
            _cancel_ids.discard(job["work_id"])
            _current = None
