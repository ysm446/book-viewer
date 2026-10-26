"""しおり。本フォルダの bookmarks.json が正本。

しおりは人が付けた、作り直せないデータなので、索引の library.db ではなく本フォルダに置く
(docs/plan/plan.md「ライブラリの構成」)。

    <書名>/bookmarks.json  {"schema": 1, "bookmarks": [{id, page, note, created_at}, ...]}

- 以前は library.db の bookmarks テーブルに置いていた。本フォルダを初めて読むときに
  そちらの行をファイルへ移し、DB からは消す。
- 本フォルダ方式より前の作品(本フォルダが無い)は、これまでどおり DB に置く。
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from . import library
from .db import connect

FILENAME = "bookmarks.json"
SCHEMA = 1

# 付け外しを続けて押したときに、読み込み → 書き込みが重なって片方を失わないように。
_lock = threading.Lock()


class BookmarkError(Exception):
    pass


class BookmarkNotFound(BookmarkError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _book_dir(root: Path, work_id: str) -> Path | None:
    """作品の本フォルダ。本フォルダ方式より前の作品なら None。"""
    with connect(root) as conn:
        row = conn.execute("SELECT rel_path FROM works WHERE id = ?", (work_id,)).fetchone()
    if row is None:
        raise BookmarkNotFound("本が見つかりません")
    return library.book_dir_for(root, row["rel_path"])


def _normalize(item: object) -> dict | None:
    if not isinstance(item, dict):
        return None
    try:
        return {
            "id": int(item["id"]),
            "page": int(item["page"]),
            "note": item.get("note") if isinstance(item.get("note"), str) else None,
            "created_at": str(item.get("created_at") or ""),
        }
    except (KeyError, TypeError, ValueError):
        return None


def _read(book_dir: Path) -> list[dict] | None:
    """bookmarks.json を読む。無ければ None。読めないときは上書きして消さないようにエラーにする。"""
    path = book_dir / FILENAME
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise BookmarkError(f"{FILENAME} を読めません: {e}")
    items = data.get("bookmarks") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise BookmarkError(f"{FILENAME} の形が正しくありません")
    return [b for b in map(_normalize, items) if b is not None]


def _write(book_dir: Path, items: list[dict]) -> None:
    items = sorted(items, key=lambda b: (b["page"], b["id"]))
    path = book_dir / FILENAME
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps({"schema": SCHEMA, "bookmarks": items}, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8",
    )
    tmp.replace(path)


def _db_rows(root: Path, work_id: str) -> list[dict]:
    with connect(root) as conn:
        rows = conn.execute(
            "SELECT id, page, note, created_at FROM bookmarks WHERE work_id = ? ORDER BY page",
            (work_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def _load(root: Path, work_id: str, book_dir: Path) -> list[dict]:
    """本フォルダのしおり。ファイルが無ければ DB に残っていた分を移してから返す。"""
    items = _read(book_dir)
    if items is not None:
        return items
    items = _db_rows(root, work_id)
    _write(book_dir, items)
    if items:
        with connect(root) as conn:
            conn.execute("DELETE FROM bookmarks WHERE work_id = ?", (work_id,))
            conn.commit()
    return items


def list_bookmarks(root: Path, work_id: str) -> list[dict]:
    book_dir = _book_dir(root, work_id)
    if book_dir is None:
        return _db_rows(root, work_id)
    with _lock:
        return sorted(_load(root, work_id, book_dir), key=lambda b: (b["page"], b["id"]))


def add_bookmark(root: Path, work_id: str, page: int, note: str | None) -> int:
    book_dir = _book_dir(root, work_id)
    if book_dir is None:
        with connect(root) as conn:
            cur = conn.execute(
                "INSERT INTO bookmarks (work_id, page, note, created_at) VALUES (?, ?, ?, ?)",
                (work_id, page, note, _now()),
            )
            conn.commit()
            return int(cur.lastrowid)
    with _lock:
        items = _load(root, work_id, book_dir)
        new_id = max((b["id"] for b in items), default=0) + 1
        items.append({"id": new_id, "page": page, "note": note, "created_at": _now()})
        _write(book_dir, items)
    return new_id


def delete_bookmark(root: Path, work_id: str, bookmark_id: int) -> None:
    book_dir = _book_dir(root, work_id)
    if book_dir is None:
        with connect(root) as conn:
            conn.execute(
                "DELETE FROM bookmarks WHERE id = ? AND work_id = ?", (bookmark_id, work_id)
            )
            conn.commit()
        return
    with _lock:
        items = _load(root, work_id, book_dir)
        _write(book_dir, [b for b in items if b["id"] != bookmark_id])
