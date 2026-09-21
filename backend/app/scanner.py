"""管理ルート直下の本フォルダを走査して works を索引化する。

本フォルダ(book.json)が正本で、works はその索引。ID は book.json の id
(取り込み時の内容フィンガープリント)なので、フォルダ名を変えても再リンクされる。
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from . import library, search
from .db import connect


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def scan(root: Path) -> dict:
    """本フォルダを索引化し、追加 / 更新 / 削除件数と未取り込みアーカイブ数を返す。

    本フォルダが見つからなくなった作品は索引から外す(読書位置・しおりも消える)。
    本フォルダ方式より前(ルート配下の zip を直接登録していた頃)の作品には触れない。
    """
    added = 0
    updated = 0
    seen: set[str] = set()

    with connect(root) as conn:
        for book_dir in library.iter_book_dirs(root):
            book = library.read_book(book_dir)
            if book is None:
                continue
            src = library.source_path(book_dir, book)
            if not src.is_file():
                continue
            fid = book["id"]
            if fid in seen:
                # 同じ本フォルダの複製は先に見つけた方だけを使う。
                continue
            seen.add(fid)
            rel = src.relative_to(root).as_posix()
            title = book.get("title") or book_dir.name
            author = book.get("author") or ""
            writing_mode = book.get("writing_mode") or "horizontal"
            pages = int(book.get("page_count") or 0)
            existing = conn.execute("SELECT id FROM works WHERE id = ?", (fid,)).fetchone()
            if existing is None:
                conn.execute(
                    "INSERT INTO works (id, rel_path, title, author, writing_mode, page_count, added_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (fid, rel, title, author, writing_mode, pages, book.get("imported_at") or _now()),
                )
                added += 1
            else:
                conn.execute(
                    "UPDATE works SET rel_path = ?, title = ?, author = ?, writing_mode = ?, "
                    "page_count = ? WHERE id = ?",
                    (rel, title, author, writing_mode, pages, fid),
                )
                updated += 1
            # 検索インデックス(タイトル + 既存の解析)を更新。
            search.update_index(conn, fid)

        removed = 0
        prefix = f"%/{library.SOURCE_DIRNAME}/%"
        for row in conn.execute(
            "SELECT id FROM works WHERE rel_path LIKE ?", (prefix,)
        ).fetchall():
            if row["id"] not in seen:
                conn.execute("DELETE FROM works WHERE id = ?", (row["id"],))
                search.remove_index(conn, row["id"])
                removed += 1
        conn.commit()
        total = conn.execute("SELECT COUNT(*) AS c FROM works").fetchone()["c"]

    loose = sum(1 for _ in library.iter_loose_archives(root))
    return {
        "added": added,
        "updated": updated,
        "removed": removed,
        "total": total,
        "scanned": len(seen),
        "loose": loose,
    }
