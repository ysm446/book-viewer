"""本の全文検索(書名・著者・章の要約・本全体の要約・文字起こしした本文)。

FTS5(trigram) を主に使い、未対応環境や短い語(<3 文字)は書名・著者の LIKE で代替する。
索引は library.db の search_index(本フォルダから作り直せる)。スキャン時と、文字起こし・
章立てと要約のジョブが終わったときに作り直す。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from .db import connect


def _fts_available(conn: sqlite3.Connection) -> bool:
    try:
        conn.execute("SELECT 1 FROM search_index LIMIT 1")
        return True
    except sqlite3.OperationalError:
        return False


def _book_text(root: Path, work_id: str) -> str:
    """索引に入れる本文と要約(本フォルダ方式でなければ空)。"""
    from . import structure, transcribe  # transcribe → progress → … の循環を避けてここで読む

    parts: list[str] = []
    try:
        st = structure.get_structure(root, work_id)
        if st.get("book_summary"):
            parts.append(st["book_summary"])
        for ch in st.get("chapters") or []:
            parts.append(ch["title"])
            if ch.get("summary"):
                parts.append(ch["summary"])
        for p in transcribe.done_pages(root, work_id):
            parts.append(transcribe.plain_for_llm(transcribe.read_text(root, work_id, p) or ""))
    except Exception:  # noqa: BLE001 - 本フォルダでない・読めないときは書名だけで索引する
        pass
    return "\n".join(parts)


def update_index(conn: sqlite3.Connection, root: Path, work_id: str) -> None:
    """既存接続内で、本の検索索引の行を作り直す。"""
    try:
        row = conn.execute("SELECT title, author FROM works WHERE id = ?", (work_id,)).fetchone()
        if not row:
            return
        content = "\n".join(p for p in (row["title"], row["author"], _book_text(root, work_id)) if p)
        conn.execute("DELETE FROM search_index WHERE work_id = ?", (work_id,))
        conn.execute("INSERT INTO search_index (work_id, content) VALUES (?, ?)", (work_id, content))
    except sqlite3.OperationalError:
        # FTS5 未対応環境では索引を持たない(検索時 LIKE で代替)。
        pass


def remove_index(conn: sqlite3.Connection, work_id: str) -> None:
    """本の検索索引の行を削除する(本の削除時)。"""
    try:
        conn.execute("DELETE FROM search_index WHERE work_id = ?", (work_id,))
    except sqlite3.OperationalError:
        pass


def search(root: Path, q: str) -> list[str]:
    q = q.strip()
    if not q:
        return []
    with connect(root) as conn:
        if _fts_available(conn) and len(q) >= 3:
            try:
                phrase = '"' + q.replace('"', '""') + '"'
                rows = conn.execute(
                    "SELECT work_id FROM search_index WHERE search_index MATCH ?", (phrase,)
                ).fetchall()
                return [r["work_id"] for r in rows]
            except sqlite3.OperationalError:
                pass
        # LIKE フォールバック(短い語 / FTS なし)
        like = f"%{q}%"
        rows = conn.execute(
            "SELECT id AS work_id FROM works WHERE title LIKE ? OR author LIKE ?", (like, like)
        ).fetchall()
        return [r["work_id"] for r in rows]
