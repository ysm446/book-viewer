"""作品解析・文字起こしのジョブキュー(単一ワーカーで順次処理)。

llama-server は基本的に1リクエストずつ処理するため、解析も1作品ずつ直列に行う。
リーダーからの単発解析もこのキュー経由に統一して同時実行の競合を避ける。
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

from . import analysis as analysis_mod
from . import llm_server
from . import structure as structure_mod
from . import transcribe as transcribe_mod
from .db import connect

_lock = threading.Lock()
_cond = threading.Condition(_lock)
_pending: list[dict] = []
_current: dict | None = None
_recent: list[dict] = []
_cancel_ids: set[str] = set()
_worker_started = False


def _resolve(root: Path, work_id: str) -> tuple[str, Path, int]:
    with connect(root) as conn:
        row = conn.execute(
            "SELECT title, rel_path, page_count FROM works WHERE id = ?", (work_id,)
        ).fetchone()
    if row is None:
        raise RuntimeError("作品が見つかりません")
    path = root / row["rel_path"]
    if not path.is_file():
        raise RuntimeError("アーカイブファイルが存在しません")
    return row["title"], path, row["page_count"]


def _ensure_worker() -> None:
    global _worker_started
    with _lock:
        if _worker_started:
            return
        _worker_started = True
    threading.Thread(target=_worker, daemon=True).start()


def enqueue(
    root: str,
    work_ids: list[str],
    sample_pages: int,
    focus_page: int | None = None,
    pages: list[int] | None = None,
    system_prompt: str | None = None,
    all_pages: bool = False,
    context_count: int = 0,
    summary_only: bool = False,
    use_story_summary: bool = False,
    story_every: int = 5,
    kind: str = "analyze",
    force: bool = False,
    engine: str = "yomitoku",
) -> dict:
    """ジョブを積む。

    kind="transcribe" は文字起こし(pages 省略時は未処理の全ページ、force で作り直し)。
    kind="structure" は章立てと要約(force で章立てから作り直し)。
    """
    with _cond:
        known = {j["work_id"] for j in _pending}
        if _current:
            known.add(_current["work_id"])
        for wid in work_ids:
            if wid in known:
                continue
            try:
                title, _, _ = _resolve(Path(root), wid)
            except RuntimeError:
                continue
            _pending.append(
                {
                    "work_id": wid,
                    "root": root,
                    "title": title,
                    "sample_pages": sample_pages,
                    "focus_page": focus_page,
                    "pages": pages,
                    "system_prompt": system_prompt,
                    "all_pages": all_pages,
                    "context_count": context_count,
                    "summary_only": summary_only,
                    "use_story_summary": use_story_summary,
                    "story_every": story_every,
                    "kind": kind,
                    "force": force,
                    "engine": engine,
                }
            )
            known.add(wid)
        _cond.notify()
    _ensure_worker()
    return snapshot()


def cancel(work_id: str) -> dict:
    with _cond:
        _pending[:] = [j for j in _pending if j["work_id"] != work_id]
        # 実行中の場合のみ中断フラグを立てる(次のページ境界で中断)。
        # 待機中だった場合に立てると、消化されずに残った ID が
        # 次回同じ作品を enqueue したときにジョブを黙って握り潰す。
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
            p = analysis_mod.get_progress(_current["work_id"]) or {}
            started = _current.get("started_at")
            current = {
                "work_id": _current["work_id"],
                "title": _current["title"],
                "kind": _current.get("kind", "analyze"),
                "current": p.get("current", 0),
                "total": p.get("total", 0),
                "phase": p.get("phase", "running"),
                "elapsed": round(time.time() - started) if started else 0,
            }
        return {
            "current": current,
            "pending": [
                {"work_id": j["work_id"], "title": j["title"], "kind": j.get("kind", "analyze")}
                for j in _pending
            ],
            "recent": list(_recent[-12:]),
        }


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
            root = Path(job["root"])
            st = llm_server.status()
            base_url = st["base_url"] if st["running"] else None
            _title, ap, page_count = _resolve(root, job["work_id"])
            if job.get("kind") == "transcribe":
                # YomiToku は LLM を使わないので、モデル未読み込みでも動く。
                transcribe_mod.transcribe_pages(
                    root,
                    job["work_id"],
                    base_url,
                    job.get("pages"),
                    engine=job.get("engine", "yomitoku"),
                    force=job.get("force", False),
                    cancel_check=lambda: job["work_id"] in _cancel_ids,
                )
            elif job.get("kind") == "structure":
                if not base_url:
                    raise RuntimeError("モデルが読み込まれていません。")
                structure_mod.run(
                    root,
                    job["work_id"],
                    base_url,
                    redo=job.get("force", False),
                    ctx_size=st.get("ctx_size"),
                    cancel_check=lambda: job["work_id"] in _cancel_ids,
                )
            else:
                if not base_url:
                    raise RuntimeError("モデルが読み込まれていません。")
                # 解析するページを決める(あらすじのみ再生成 / 全ページ / 明示指定 / 未解析から増分)。
                if job.get("summary_only"):
                    # ページ解析はスキップし、既存キャプションからあらすじ + タグを再生成する。
                    pages = []
                elif job.get("all_pages"):
                    pages = list(range(page_count))
                elif job.get("pages"):
                    pages = [p for p in job["pages"] if 0 <= p < page_count]
                else:
                    analyzed = set(analysis_mod.get_analyzed_pages(root, job["work_id"]))
                    pages = analysis_mod.pick_incremental(
                        page_count, analyzed, job["sample_pages"], job.get("focus_page")
                    )
                analysis_mod.analyze_pages(
                    root,
                    job["work_id"],
                    ap,
                    base_url,
                    pages,
                    system_prompt=job.get("system_prompt"),
                    context_count=job.get("context_count", 0),
                    use_story_summary=job.get("use_story_summary", False),
                    story_every=job.get("story_every", 5),
                    # 全ページを先頭から順に解析するときだけ、走行 state(causal)をページ文脈に使える。
                    sequential=job.get("all_pages", False),
                    cancel_check=lambda: job["work_id"] in _cancel_ids,
                )
        except analysis_mod.Cancelled:
            status, error = "canceled", None
        except Exception as e:  # noqa: BLE001 - ワーカーは落とさない
            status, error = "error", str(e)

        # 途中終了時、analysis.status が 'running' のまま固まらないようにする
        # (story state の走行更新は 'running' で INSERT され、完走時のみ 'done' になる)。
        if status != "done":
            try:
                with connect(Path(job["root"])) as conn:
                    conn.execute(
                        "UPDATE analysis SET status = ? WHERE work_id = ? AND status = 'running'",
                        (status, job["work_id"]),
                    )
                    conn.commit()
            except Exception:  # noqa: BLE001 - 後始末の失敗でワーカーは落とさない
                pass

        with _lock:
            _recent.append(
                {
                    "work_id": job["work_id"],
                    "title": job["title"],
                    "kind": job.get("kind", "analyze"),
                    "status": status,
                    "error": error,
                }
            )
            _cancel_ids.discard(job["work_id"])
            _current = None
