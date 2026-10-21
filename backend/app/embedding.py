"""本文検索(M5): 埋め込みモデルによる索引づくりと検索。

- 本文(アプリ用の本文)を数百字のまとまり(chunk)に分け、埋め込みベクトルにして library.db の
  chunks に保存する(本フォルダから作り直せる索引)。
- 埋め込みは日本語向けの Ruri v3(cl-nagoya/ruri-v3-310m)を、バックエンドの中で
  sentence-transformers で動かす(別のサーバーは起動しない)。モデルは初回に Hugging Face から
  <リポジトリ>/models/embeddings/ に取得し、以後はそこから読む。CUDA が使えれば GPU、無ければ CPU。
- 検索はチャットの質問をベクトルにし、今のページまでのまとまりから近いものを返す(ネタバレ防止)。
"""

from __future__ import annotations

import hashlib
import re
import threading
from array import array
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import content, transcribe
from .progress import Cancelled, clear_progress, set_progress
from .db import connect

MODEL_NAME = "cl-nagoya/ruri-v3-310m"
# モデルの置き場(Hugging Face のキャッシュ形式)。models/ は git 管理外。
CACHE_DIR = Path(__file__).resolve().parents[2] / "models" / "embeddings"

# まとまり 1 つの目安(文字数)。段落を足していき、これを超えたら区切る。
_CHUNK_CHARS = 500
# 1 段落がこれより長ければ、文の切れ目で分ける。
_PARAGRAPH_MAX = 800
_BATCH = 16

# Ruri v3 は検索する側と本文の側で違う前置きを付けて学習されている(付けないと精度が出ない)。
_QUERY_PREFIX = "検索クエリ: "
_DOCUMENT_PREFIX = "検索文書: "


class EmbeddingError(RuntimeError):
    pass


# ---- 埋め込みモデル(Ruri v3) ----------------------------------------------------

_model = None
_model_lock = threading.Lock()


def _get_model():
    """モデルを(読み込んでいなければ)読み込む。初回は Hugging Face から取得する。"""
    global _model
    with _model_lock:
        if _model is None:
            try:
                import torch
                from sentence_transformers import SentenceTransformer

                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                device = "cuda" if torch.cuda.is_available() else "cpu"
                _model = SentenceTransformer(MODEL_NAME, cache_folder=str(CACHE_DIR), device=device)
            except Exception as e:  # noqa: BLE001 - 取得失敗(オフライン等)も読み込み失敗も同じく伝える
                raise EmbeddingError(
                    f"埋め込みモデル({MODEL_NAME})を読み込めません。初回はネットワークから取得します: {e}"
                ) from e
        return _model


def stop() -> None:
    """読み込んだモデルを手放す(バックエンド終了時)。"""
    global _model
    with _model_lock:
        if _model is None:
            return
        _model = None
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001 - 後片付けなので失敗しても止めない
        pass


def embed(texts: list[str], *, query: bool = False) -> list[list[float]]:
    """文のリストを埋め込みベクトル(正規化済み)にする。query=True は質問の側、False は本文の側。"""
    prefix = _QUERY_PREFIX if query else _DOCUMENT_PREFIX
    model = _get_model()
    try:
        vectors = model.encode(
            [prefix + t for t in texts],
            batch_size=_BATCH,
            normalize_embeddings=True,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
    except Exception as e:  # noqa: BLE001 - GPU のメモリ不足なども埋め込みの失敗として伝える
        raise EmbeddingError(f"埋め込みに失敗しました: {e}") from e
    return [v.tolist() for v in vectors]


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
    """索引の状態: {chunks, stale(本文か埋め込みモデルが変わった), model, updated_at}。"""
    with connect(root) as conn:
        row = conn.execute(
            "SELECT signature, model, chunk_count, updated_at FROM chunk_index WHERE work_id = ?",
            (work_id,),
        ).fetchone()
    try:
        current = _signature(_page_texts(root, work_id))
    except transcribe.TranscribeError:
        current = None
    model_changed = bool(row) and row["model"] != MODEL_NAME
    return {
        "chunks": row["chunk_count"] if row else 0,
        "stale": bool(row) and (row["signature"] != current or model_changed),
        "model": row["model"] if row else None,
        "updated_at": row["updated_at"] if row else None,
    }


def build_index(
    root: Path,
    work_id: str,
    cancel_check: Callable[[], bool] | None = None,
) -> int:
    """本文を分けて埋め込み、索引を作り直す。まとまりの数を返す。"""
    pages = _page_texts(root, work_id)
    if not pages:
        raise EmbeddingError("文字起こしされたページがありません。先に文字起こしをしてください。")
    # アプリ用の本文を分ける(ページをまたいで切れた段落はつないであり、続きは始まりのページの
    # まとまりに入る)。
    chunks = chunk_pages(content.page_texts(root, work_id))
    # 先のページの書き出しを取り込んだまとまりは page_end = その続きのページ。検索で「今のページまで」に
    # 絞るときにそのまとまりを外し、先の内容が混ざらないようにする。
    continued = content.continued_pages(root, work_id)
    page_end: list[int | None] = []
    for n, (page, _) in enumerate(chunks):
        last_of_page = n + 1 == len(chunks) or chunks[n + 1][0] != page
        page_end.append(continued.get(page) if last_of_page else None)
    total = len(chunks)
    vectors: list[bytes] = []
    set_progress(work_id, 0, total, "index")
    try:
        for i in range(0, total, _BATCH):
            if cancel_check and cancel_check():
                raise Cancelled()
            batch = [text for _, text in chunks[i : i + _BATCH]]
            vectors.extend(array("f", v).tobytes() for v in embed(batch))
            set_progress(work_id, min(i + _BATCH, total), total, "index")
    finally:
        clear_progress(work_id)
    with connect(root) as conn:
        conn.execute("DELETE FROM chunks WHERE work_id = ?", (work_id,))
        conn.executemany(
            "INSERT INTO chunks (work_id, seq, page, page_end, text, embedding) VALUES (?, ?, ?, ?, ?, ?)",
            [
                (work_id, n, page, page_end[n], text, vectors[n])
                for n, (page, text) in enumerate(chunks)
            ],
        )
        conn.execute(
            "INSERT INTO chunk_index (work_id, signature, model, chunk_count, updated_at) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT(work_id) DO UPDATE SET signature = excluded.signature, "
            "model = excluded.model, chunk_count = excluded.chunk_count, updated_at = excluded.updated_at",
            (work_id, _signature(pages), MODEL_NAME, total, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
    return total


def search(
    root: Path,
    work_id: str,
    query: str,
    *,
    max_page: int | None,
    exclude_pages: set[int] | None = None,
    k: int = 6,
) -> list[dict]:
    """質問に近い本文のまとまりを、今のページ(max_page)まで・exclude_pages 以外から k 件返す。

    索引が無い・別の埋め込みモデルで作った古い索引なら空を返す(作り直しは状態表示で促す)。
    戻り値は [{page, text, score}] を近い順に。
    """
    import numpy as np

    with connect(root) as conn:
        meta = conn.execute("SELECT model FROM chunk_index WHERE work_id = ?", (work_id,)).fetchone()
        if meta is None or meta["model"] != MODEL_NAME:
            return []
        rows = conn.execute(
            "SELECT page, text, embedding FROM chunks WHERE work_id = ?"
            + (" AND COALESCE(page_end, page) <= ?" if max_page is not None else "")
            + " ORDER BY seq",
            (work_id, max_page) if max_page is not None else (work_id,),
        ).fetchall()
    rows = [r for r in rows if not exclude_pages or r["page"] not in exclude_pages]
    if not rows or not query.strip():
        return []
    q = np.asarray(embed([query.strip()], query=True)[0], dtype=np.float32)
    mat = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
    if mat.shape[1] != q.shape[0]:
        raise EmbeddingError(
            "索引を作ったときと埋め込みモデルが違います。「索引を作る」で作り直してください。"
        )
    scores = mat @ q  # 正規化済みなので内積 = コサイン類似度
    order = np.argsort(-scores)[:k]
    return [
        {"page": rows[i]["page"], "text": rows[i]["text"], "score": float(scores[i])} for i in order
    ]
