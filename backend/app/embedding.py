"""本文検索(M5): 埋め込みモデルによる索引づくりと検索。

- 本文(pages/*.md)を数百字のまとまり(chunk)に分け、埋め込みベクトルにして library.db の
  chunks に保存する(本フォルダから作り直せる索引)。
- 埋め込みは、会話用とは別の llama-server を埋め込み専用(--embedding)で起動して作る。
  モデルはモデル置き場から名前に "embed" を含む GGUF を自動で選ぶ(例: Qwen3-Embedding-4B)。
  会話用のモデルと同時に載せられるよう、別ポートで必要になったときだけ起動する。
- 検索はチャットの質問をベクトルにし、今のページまでのまとまりから近いものを返す(ネタバレ防止)。
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from array import array
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import llm, llm_server, transcribe
from .progress import Cancelled, clear_progress, set_progress
from .db import connect

EMBED_URL = "http://127.0.0.1:8091/v1"
_LOG_PATH = llm_server.LOG_PATH.with_name("llama-embedding.log")

# まとまり 1 つの目安(文字数)。段落を足していき、これを超えたら区切る。
_CHUNK_CHARS = 500
# 1 段落がこれより長ければ、文の切れ目で分ける。
_PARAGRAPH_MAX = 800
_BATCH = 16

# Qwen3-Embedding は、検索する側の文に指示文を付けて埋め込む(本文の側には付けない)。
_QUERY_PREFIX = (
    "Instruct: Given a reader's question about a book, retrieve passages from the book "
    "that help answer the question\nQuery: "
)


class EmbeddingError(RuntimeError):
    pass


# ---- 埋め込み用の llama-server ------------------------------------------------


class _State:
    proc: subprocess.Popen | None = None
    model: str | None = None
    log = None  # type: ignore[assignment]


_state = _State()
_lock = threading.RLock()


def find_model(models_dir: str | None) -> Path | None:
    """モデル置き場から埋め込みモデル(名前に embed を含む GGUF)を探す。"""
    d = llm_server.resolve_models_dir(models_dir)
    if not d.is_dir():
        return None
    for gguf in sorted(d.rglob("*.gguf")):
        name = gguf.name.lower()
        if "embed" in name and "mmproj" not in name:
            return gguf
    return None


def running() -> bool:
    with _lock:
        return _state.proc is not None and _state.proc.poll() is None


def ensure_server(server_path: str | None, models_dir: str | None, timeout: float = 180.0) -> str:
    """埋め込み用の llama-server を(起動していなければ)起動し、接続先を返す。"""
    with _lock:
        if running():
            return EMBED_URL
        binary = llm_server.find_server_binary(server_path)
        if not binary:
            raise EmbeddingError("llama-server の実行ファイルが見つかりません。")
        model = find_model(models_dir)
        if model is None:
            raise EmbeddingError(
                "埋め込みモデルが見つかりません。モデル置き場に名前に Embedding を含む GGUF"
                "(例: Qwen3-Embedding-4B)を置いてください。"
            )
        host, port = llm_server._parse_host_port(EMBED_URL)
        args = [
            binary,
            "-m",
            str(model),
            "--host",
            host,
            "--port",
            str(port),
            "--embedding",
            "--pooling",
            "last",
            "-c",
            "8192",
            "-b",
            "8192",
            "-ub",
            "8192",
            "-ngl",
            str(llm_server._auto_ngl(binary)),
        ]
        _LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        _state.log = open(_LOG_PATH, "w", encoding="utf-8", errors="replace")
        _state.proc = subprocess.Popen(args, stdout=_state.log, stderr=subprocess.STDOUT)
        _state.model = model.stem
        deadline = time.time() + timeout
        while time.time() < deadline:
            if _state.proc.poll() is not None:
                stop()
                raise EmbeddingError("埋め込み用の llama-server が起動直後に終了しました。")
            if llm.ping(EMBED_URL):
                return EMBED_URL
            time.sleep(0.5)
        stop()
        raise EmbeddingError("埋め込み用の llama-server の起動確認がタイムアウトしました。")


def stop() -> None:
    with _lock:
        if _state.proc is not None:
            try:
                _state.proc.terminate()
                try:
                    _state.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    _state.proc.kill()
            except OSError:
                pass
        _state.proc = None
        _state.model = None
        if _state.log is not None:
            try:
                _state.log.close()
            except OSError:
                pass
            _state.log = None


def embed(texts: list[str], base_url: str = EMBED_URL) -> list[list[float]]:
    """文のリストを埋め込みベクトル(正規化済み)にする。"""
    out: list[list[float]] = []
    for i in range(0, len(texts), _BATCH):
        batch = texts[i : i + _BATCH]
        data = json.dumps({"input": batch, "model": "embedding"}).encode("utf-8")
        req = urllib.request.Request(
            base_url.rstrip("/") + "/embeddings",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=300) as res:
                body = json.loads(res.read().decode("utf-8"))
        except urllib.error.URLError as e:
            raise EmbeddingError(f"埋め込みに失敗しました: {e}") from e
        items = sorted(body.get("data") or [], key=lambda d: d.get("index", 0))
        if len(items) != len(batch):
            raise EmbeddingError("埋め込みの応答が不正です")
        out.extend(item["embedding"] for item in items)
    return out


# ---- 本文の分割と索引 ----------------------------------------------------------


def _paragraphs(text: str) -> list[str]:
    out = []
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        while len(para) > _PARAGRAPH_MAX:
            cut = para.rfind("。", 0, _PARAGRAPH_MAX)
            cut = cut + 1 if cut > _PARAGRAPH_MAX // 3 else _PARAGRAPH_MAX
            out.append(para[:cut])
            para = para[cut:].strip()
        if para:
            out.append(para)
    return out


def chunk_pages(pages: dict[int, str]) -> list[tuple[int, str]]:
    """(始まりのページ, 本文) のまとまりに分ける。まとまりはページをまたがない。"""
    chunks: list[tuple[int, str]] = []
    for page in sorted(pages):
        buf = ""
        for para in _paragraphs(transcribe.plain_for_llm(pages[page])):
            if buf and len(buf) + len(para) > _CHUNK_CHARS:
                chunks.append((page, buf))
                buf = ""
            buf = f"{buf}\n{para}" if buf else para
        if buf:
            chunks.append((page, buf))
    return chunks


def _signature(pages: dict[int, str]) -> str:
    """本文の内容の指紋。文字起こしや手直しで変わったら索引を作り直す目安にする。"""
    h = hashlib.sha1()
    for page in sorted(pages):
        h.update(f"{page}\n".encode())
        h.update(pages[page].encode("utf-8"))
    return h.hexdigest()


def _page_texts(root: Path, work_id: str) -> dict[int, str]:
    return {p: transcribe.read_text(root, work_id, p) or "" for p in transcribe.done_pages(root, work_id)}


def status(root: Path, work_id: str) -> dict:
    """索引の状態: {chunks, stale(本文が変わった), model, embedding_model(見つかったもの)}。"""
    with connect(root) as conn:
        row = conn.execute(
            "SELECT signature, model, chunk_count, updated_at FROM chunk_index WHERE work_id = ?",
            (work_id,),
        ).fetchone()
    try:
        current = _signature(_page_texts(root, work_id))
    except transcribe.TranscribeError:
        current = None
    return {
        "chunks": row["chunk_count"] if row else 0,
        "stale": bool(row) and row["signature"] != current,
        "model": row["model"] if row else None,
        "updated_at": row["updated_at"] if row else None,
    }


def build_index(
    root: Path,
    work_id: str,
    server_path: str | None,
    models_dir: str | None,
    cancel_check: Callable[[], bool] | None = None,
) -> int:
    """本文を分けて埋め込み、索引を作り直す。まとまりの数を返す。"""
    pages = _page_texts(root, work_id)
    if not pages:
        raise EmbeddingError("文字起こしされたページがありません。先に文字起こしをしてください。")
    chunks = chunk_pages(pages)
    base_url = ensure_server(server_path, models_dir)
    total = len(chunks)
    vectors: list[bytes] = []
    set_progress(work_id, 0, total, "index")
    try:
        for i in range(0, total, _BATCH):
            if cancel_check and cancel_check():
                raise Cancelled()
            batch = [text for _, text in chunks[i : i + _BATCH]]
            vectors.extend(array("f", v).tobytes() for v in embed(batch, base_url))
            set_progress(work_id, min(i + _BATCH, total), total, "index")
    finally:
        clear_progress(work_id)
    with connect(root) as conn:
        conn.execute("DELETE FROM chunks WHERE work_id = ?", (work_id,))
        conn.executemany(
            "INSERT INTO chunks (work_id, seq, page, text, embedding) VALUES (?, ?, ?, ?, ?)",
            [(work_id, n, page, text, vectors[n]) for n, (page, text) in enumerate(chunks)],
        )
        conn.execute(
            "INSERT INTO chunk_index (work_id, signature, model, chunk_count, updated_at) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT(work_id) DO UPDATE SET signature = excluded.signature, "
            "model = excluded.model, chunk_count = excluded.chunk_count, updated_at = excluded.updated_at",
            (work_id, _signature(pages), _state.model, total, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
    return total


def search(
    root: Path,
    work_id: str,
    query: str,
    server_path: str | None,
    models_dir: str | None,
    *,
    max_page: int | None,
    exclude_pages: set[int] | None = None,
    k: int = 6,
) -> list[dict]:
    """質問に近い本文のまとまりを、今のページ(max_page)まで・exclude_pages 以外から k 件返す。

    索引が無ければ空を返す。戻り値は [{page, text, score}] を近い順に。
    """
    import numpy as np

    with connect(root) as conn:
        rows = conn.execute(
            "SELECT page, text, embedding FROM chunks WHERE work_id = ?"
            + (" AND page <= ?" if max_page is not None else "")
            + " ORDER BY seq",
            (work_id, max_page) if max_page is not None else (work_id,),
        ).fetchall()
    rows = [r for r in rows if not exclude_pages or r["page"] not in exclude_pages]
    if not rows or not query.strip():
        return []
    base_url = ensure_server(server_path, models_dir)
    q = np.asarray(embed([_QUERY_PREFIX + query.strip()], base_url)[0], dtype=np.float32)
    mat = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
    scores = mat @ q  # 正規化済みなので内積 = コサイン類似度
    order = np.argsort(-scores)[:k]
    return [
        {"page": rows[i]["page"], "text": rows[i]["text"], "score": float(scores[i])} for i in order
    ]
