"""全文検索(タイトル + あらすじ + ページ説明)。

FTS5(trigram) を主に使い、未対応環境や短い語(<3文字)は LIKE で代替する。
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


def update_index(conn: sqlite3.Connection, work_id: str) -> None:
    """既存接続内で、作品の検索インデックス行を作り直す。"""
    try:
        row = conn.execute("SELECT title FROM works WHERE id = ?", (work_id,)).fetchone()
        if not row:
            return
        srow = conn.execute(
            "SELECT summary FROM analysis WHERE work_id = ?", (work_id,)
        ).fetchone()
        summary = (srow["summary"] if srow else "") or ""
        # ページ説明に加えて OCR テキスト(セリフ)も索引に含める。
        pages = " ".join(
            part
            for r in conn.execute(
                "SELECT description, text FROM page_analysis WHERE work_id = ?", (work_id,)
            ).fetchall()
            for part in (r["description"] or "", r["text"] or "")
            if part
        )
        content = " ".join(p for p in (row["title"], summary, pages) if p)
        conn.execute("DELETE FROM search_index WHERE work_id = ?", (work_id,))
        conn.execute(
            "INSERT INTO search_index (work_id, content) VALUES (?, ?)", (work_id, content)
        )
    except sqlite3.OperationalError:
        # FTS5 未対応環境では索引を持たない(検索時 LIKE で代替)。
        pass


def remove_index(conn: sqlite3.Connection, work_id: str) -> None:
    """作品の検索インデックス行を削除する(作品削除時)。"""
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
            """
            SELECT w.id AS work_id FROM works w
            LEFT JOIN analysis a ON a.work_id = w.id
            WHERE w.title LIKE ? OR a.summary LIKE ?
            UNION
            SELECT work_id FROM page_analysis WHERE description LIKE ? OR text LIKE ?
            """,
            (like, like, like, like),
        ).fetchall()
        return [r["work_id"] for r in rows]
