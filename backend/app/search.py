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
    from . import content, structure, transcribe  # transcribe → progress → … の循環を避けてここで読む

    parts: list[str] = []
    try:
        st = structure.get_structure(root, work_id)
        if st.get("book_summary"):
            parts.append(st["book_summary"])
        for ch in st.get("chapters") or []:
            parts.append(ch["title"])
            if ch.get("summary"):
                parts.append(ch["summary"])
        # 本文はアプリ用の本文(ページをまたいで切れた段落をつないだもの)から取る。
        for text in content.page_texts(root, work_id).values():
            parts.append(transcribe.plain_for_llm(text))
    except Exception:  # noqa: BLE001 - 本フォルダでない・読めないときは書名だけで索引する
        pass
    return "\n".join(parts)


def content_signature(book_dir: Path | None, title: str, author: str) -> str:
    """索引の元になるものの指紋(書名・著者と、本文・要約ファイルの数と更新時刻)。

    ファイルの中身は読まない(スキャンのたびに全ページを読まないための目安)。
    """
    parts = [title, author]
    if book_dir is not None:
        for sub in ("pages", "summaries"):
            d = book_dir / sub
            if not d.is_dir():
                continue
            latest = 0
            count = 0
            for f in d.iterdir():
                try:
                    latest = max(latest, f.stat().st_mtime_ns)
                except OSError:
                    continue
                count += 1
            parts.append(f"{sub}:{count}:{latest}")
        try:
            parts.append(str((book_dir / "book.json").stat().st_mtime_ns))
        except OSError:
            pass
    return "|".join(parts)


def update_index(
    conn: sqlite3.Connection,
    root: Path,
    work_id: str,
    *,
    book_dir: Path | None = None,
    only_if_changed: bool = False,
) -> None:
    """既存接続内で、本の検索索引の行を作り直す。

    only_if_changed=True なら、前回索引を作ったときと指紋(content_signature)が同じ本は
    読み直さない。
    """
    try:
        row = conn.execute("SELECT title, author FROM works WHERE id = ?", (work_id,)).fetchone()
        if not row:
            return
        sig = content_signature(book_dir, row["title"], row["author"])
        if only_if_changed:
            prev = conn.execute(
                "SELECT signature FROM search_meta WHERE work_id = ?", (work_id,)
            ).fetchone()
            if prev and prev["signature"] == sig:
                return
        content = "\n".join(p for p in (row["title"], row["author"], _book_text(root, work_id)) if p)
        conn.execute("DELETE FROM search_index WHERE work_id = ?", (work_id,))
        conn.execute("INSERT INTO search_index (work_id, content) VALUES (?, ?)", (work_id, content))
        conn.execute(
            "INSERT INTO search_meta (work_id, signature) VALUES (?, ?) "
            "ON CONFLICT(work_id) DO UPDATE SET signature = excluded.signature",
            (work_id, sig),
        )
    except sqlite3.OperationalError:
        # FTS5 未対応環境では索引を持たない(検索時 LIKE で代替)。
        pass


def remove_index(conn: sqlite3.Connection, work_id: str) -> None:
    """本の検索索引の行を削除する(本の削除時)。"""
    try:
        conn.execute("DELETE FROM search_meta WHERE work_id = ?", (work_id,))
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
        # LIKE フォールバック(短い語 / FTS なし)。% と _ はそのままだとワイルドカードになる。
        like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        rows = conn.execute(
            "SELECT id AS work_id FROM works WHERE title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\'",
            (like, like),
        ).fetchall()
        return [r["work_id"] for r in rows]
