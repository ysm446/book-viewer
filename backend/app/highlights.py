"""ハイライト。本フォルダの highlights.json が正本。

テキスト表示で選んだ範囲に付ける色とメモ。しおりと同じく人が付けた作り直せないデータなので、
索引の library.db ではなく本フォルダに置く(docs/plan/plan.md「ハイライト」)。

    <書名>/highlights.json  {"schema": 1, "highlights": [{id, color, note, text, created_at, updated_at, parts}, ...]}

parts は段落(アプリ用の本文のブロック)ごとの範囲 {key, block, page, start, end, text, prefix, suffix}。
位置の付け直しはレンダラーが行うので、ここでは形だけ確かめて保存する。
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from . import library
from .db import connect

FILENAME = "highlights.json"
SCHEMA = 1
COLORS = ("yellow", "green", "pink")

# 前後の文字列の上限(レンダラーは 32 字で送る。手で直した JSON の巨大な値で膨らませない)
_CONTEXT_MAX = 200
_TEXT_MAX = 20000
_NOTE_MAX = 10000

_lock = threading.Lock()


class HighlightError(Exception):
    pass


class HighlightNotFound(HighlightError):
    pass


class HighlightInvalid(HighlightError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _book_dir(root: Path, work_id: str) -> Path:
    with connect(root) as conn:
        row = conn.execute("SELECT rel_path FROM works WHERE id = ?", (work_id,)).fetchone()
    if row is None:
        raise HighlightNotFound("本が見つかりません")
    book_dir = library.book_dir_for(root, row["rel_path"])
    if book_dir is None:
        raise HighlightInvalid("本フォルダに取り込んだ本だけハイライトを付けられます")
    return book_dir


def _part(item: object) -> dict | None:
    if not isinstance(item, dict):
        return None
    try:
        part = {
            "key": str(item["key"]),
            "block": int(item["block"]),
            "page": int(item["page"]),
            "start": int(item["start"]),
            "end": int(item["end"]),
            "text": str(item["text"])[:_TEXT_MAX],
            "prefix": str(item.get("prefix") or "")[-_CONTEXT_MAX:],
            "suffix": str(item.get("suffix") or "")[:_CONTEXT_MAX],
        }
    except (KeyError, TypeError, ValueError):
        return None
    if part["start"] < 0 or part["end"] <= part["start"] or not part["text"]:
        return None
    return part


def _color(value: object) -> str:
    return value if value in COLORS else COLORS[0]


def _note(value: object) -> str | None:
    return value[:_NOTE_MAX] if isinstance(value, str) and value.strip() else None


def _normalize(item: object) -> dict | None:
    if not isinstance(item, dict):
        return None
    parts = [p for p in map(_part, item.get("parts") or []) if p is not None]
    try:
        hid = int(item["id"])
    except (KeyError, TypeError, ValueError):
        return None
    if not parts:
        return None
    return {
        "id": hid,
        "color": _color(item.get("color")),
        "note": _note(item.get("note")),
        "text": str(item.get("text") or "\n".join(p["text"] for p in parts))[:_TEXT_MAX],
        "created_at": str(item.get("created_at") or ""),
        "updated_at": str(item.get("updated_at") or item.get("created_at") or ""),
        "parts": parts,
    }


def _order(h: dict) -> tuple:
    p = h["parts"][0]
    return (p["page"], p["block"], p["start"], h["id"])


def _read(book_dir: Path) -> list[dict]:
    """highlights.json を読む。無ければ空。読めないときは上書きして消さないようにエラーにする。"""
    path = book_dir / FILENAME
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise HighlightError(f"{FILENAME} を読めません: {e}")
    items = data.get("highlights") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise HighlightError(f"{FILENAME} の形が正しくありません")
    return [h for h in map(_normalize, items) if h is not None]


def _write(book_dir: Path, items: list[dict]) -> None:
    path = book_dir / FILENAME
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps({"schema": SCHEMA, "highlights": sorted(items, key=_order)}, ensure_ascii=False, indent=1)
        + "\n",
        encoding="utf-8",
    )
    tmp.replace(path)


def list_highlights(root: Path, work_id: str) -> list[dict]:
    book_dir = _book_dir(root, work_id)
    return sorted(_read(book_dir), key=_order)


def add_highlight(root: Path, work_id: str, data: dict) -> dict:
    book_dir = _book_dir(root, work_id)
    with _lock:
        items = _read(book_dir)
        now = _now()
        h = _normalize(
            {**data, "id": max((x["id"] for x in items), default=0) + 1, "created_at": now, "updated_at": now}
        )
        if h is None:
            raise HighlightInvalid("ハイライトの範囲が正しくありません")
        items.append(h)
        _write(book_dir, items)
    return h


def update_highlight(root: Path, work_id: str, highlight_id: int, changes: dict) -> dict:
    """色・メモを変える(changes に含まれる項目だけ)。"""
    book_dir = _book_dir(root, work_id)
    with _lock:
        items = _read(book_dir)
        h = next((x for x in items if x["id"] == highlight_id), None)
        if h is None:
            raise HighlightNotFound("ハイライトが見つかりません")
        if "color" in changes:
            h["color"] = _color(changes["color"])
        if "note" in changes:
            h["note"] = _note(changes["note"])
        h["updated_at"] = _now()
        _write(book_dir, items)
    return h


def delete_highlight(root: Path, work_id: str, highlight_id: int) -> None:
    book_dir = _book_dir(root, work_id)
    with _lock:
        items = _read(book_dir)
        rest = [x for x in items if x["id"] != highlight_id]
        if len(rest) != len(items):
            _write(book_dir, rest)
