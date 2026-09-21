"""本フォルダ(1冊 = 1フォルダ)の配置と取り込み。

方針(docs/plan/plan.md「ライブラリの構成」):
- 管理ルート直下に本ごとのフォルダを作り、その中に元アーカイブと生成物を置く。
- 本フォルダの正本は book.json。library.db は索引なので、本フォルダから作り直せる。

    <管理ルート>/
    ├─ .book-viewer/library.db
    └─ <書名>/
        ├─ book.json
        └─ source/original.zip
"""

from __future__ import annotations

import json
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from . import archive, fingerprint
from .config import ARCHIVE_EXTENSIONS, DATA_DIRNAME, LEGACY_DATA_DIRNAME

BOOK_FILENAME = "book.json"
SOURCE_DIRNAME = "source"
SOURCE_STEM = "original"
SCHEMA_VERSION = 1

WRITING_MODES = ("horizontal", "vertical")

# Windows で使えない文字。フォルダ名では "_" に置き換える。
_INVALID_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
# 先頭の日時プレフィックス(例: "2026-09-20_1847_")。書名の初期値から取り除く。
_DATE_PREFIX_RE = re.compile(r"^\d{4}-?\d{2}-?\d{2}[_\- ]\d{4,6}[_\- ]+")
_MAX_DIRNAME = 80


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def title_from_filename(path: Path) -> str:
    """ファイル名から書名の初期値を作る(日時プレフィックスを除く)。"""
    stem = path.stem
    title = _DATE_PREFIX_RE.sub("", stem).strip()
    return title or stem


def sanitize_dirname(name: str) -> str:
    """書名をフォルダ名に使える形にする(末尾の空白・ピリオドも落とす)。"""
    cleaned = _INVALID_CHARS_RE.sub("_", name).strip().rstrip(". ")
    return cleaned[:_MAX_DIRNAME].rstrip(". ") or "untitled"


def unique_dir(root: Path, name: str) -> Path:
    """同名フォルダがあれば "name (2)" のように番号を足した未使用パスを返す。"""
    base = sanitize_dirname(name)
    path = root / base
    i = 2
    while path.exists():
        path = root / f"{base} ({i})"
        i += 1
    return path


def is_book_dir(path: Path) -> bool:
    return path.is_dir() and (path / BOOK_FILENAME).is_file()


def iter_book_dirs(root: Path):
    """管理ルート直下の本フォルダを列挙する。"""
    for child in sorted(root.iterdir()):
        if child.name in (DATA_DIRNAME, LEGACY_DATA_DIRNAME):
            continue
        if is_book_dir(child):
            yield child


def read_book(book_dir: Path) -> dict | None:
    """book.json を読む。壊れていれば None。"""
    try:
        data = json.loads((book_dir / BOOK_FILENAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not data.get("id") or not data.get("source"):
        return None
    return data


def write_book(book_dir: Path, data: dict) -> None:
    """book.json を一時ファイル経由で置き換える(途中で壊れないように)。"""
    path = book_dir / BOOK_FILENAME
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def source_path(book_dir: Path, book: dict) -> Path:
    return book_dir / book["source"]


def book_dir_for(root: Path, rel_path: str) -> Path | None:
    """works.rel_path(元アーカイブ)から本フォルダを返す。本フォルダ方式でなければ None。"""
    src = root / rel_path
    if src.parent.name != SOURCE_DIRNAME:
        return None
    book_dir = src.parent.parent
    return book_dir if book_dir != root and is_book_dir(book_dir) else None


def rename_book(root: Path, book_dir: Path, title: str) -> Path:
    """書名を変更し、フォルダ名も追従させる。新しい本フォルダを返す。"""
    book = read_book(book_dir)
    if book is None:
        raise LibraryError("book.json を読めません")
    new_dir = root / sanitize_dirname(title)
    if new_dir.name != book_dir.name:
        # 大文字小文字だけの変更は同じフォルダとして扱う(Windows)。
        if new_dir.exists() and new_dir.name.lower() != book_dir.name.lower():
            raise LibraryError("同名のフォルダが既にあります")
        book_dir.rename(new_dir)
    book["title"] = title
    write_book(new_dir, book)
    return new_dir


def iter_loose_archives(root: Path):
    """本フォルダに入っていない(未取り込みの)アーカイブを列挙する。"""
    for path in sorted(root.rglob("*")):
        rel_parts = path.relative_to(root).parts
        if rel_parts[0] in (DATA_DIRNAME, LEGACY_DATA_DIRNAME):
            continue
        if not path.is_file() or path.suffix.lower() not in ARCHIVE_EXTENSIONS:
            continue
        # 本フォルダ配下のものは取り込み済み。
        if any(is_book_dir(root.joinpath(*rel_parts[:i])) for i in range(1, len(rel_parts))):
            continue
        yield path


class LibraryError(Exception):
    """取り込みを続けられない入力(利用者に見せる理由付き)。"""


def import_archive(
    root: Path,
    src: Path,
    *,
    mode: str = "copy",
    title: str | None = None,
    author: str = "",
    writing_mode: str = "horizontal",
    known_ids: set[str] | None = None,
) -> dict:
    """アーカイブを本フォルダとして取り込み、book.json の内容を返す。

    mode: "copy"(元を残す)/ "move"(元を移動する)。
    known_ids に同じ内容の ID があれば重複として LibraryError を送出する。
    """
    if mode not in ("copy", "move"):
        raise LibraryError("mode は copy / move のいずれかです")
    if writing_mode not in WRITING_MODES:
        raise LibraryError("writing_mode は horizontal / vertical のいずれかです")
    if not src.is_file():
        raise LibraryError("ファイルが見つかりません")
    if src.suffix.lower() not in ARCHIVE_EXTENSIONS:
        raise LibraryError("対応していない形式です(zip / cbz / pdf)")
    try:
        pages = archive.page_count(src)
    except (zipfile.BadZipFile, OSError) as e:
        raise LibraryError(f"アーカイブを開けません: {e}")
    if pages == 0:
        raise LibraryError("ページ画像が含まれていません")

    book_id = fingerprint.compute(src)
    if known_ids is not None and book_id in known_ids:
        raise LibraryError("同じ本が既に取り込まれています")

    name = (title or "").strip() or title_from_filename(src)
    book_dir = unique_dir(root, name)
    source_rel = f"{SOURCE_DIRNAME}/{SOURCE_STEM}{src.suffix.lower()}"
    dest = book_dir / source_rel
    dest.parent.mkdir(parents=True)
    try:
        if mode == "move":
            shutil.move(str(src), dest)
        else:
            shutil.copy2(src, dest)
        book = {
            "schema": SCHEMA_VERSION,
            "id": book_id,
            "title": name,
            "author": author.strip(),
            "writing_mode": writing_mode,
            "source": source_rel,
            "original_filename": src.name,
            "page_count": pages,
            "imported_at": _now(),
        }
        write_book(book_dir, book)
    except BaseException:
        # 途中まで作ったフォルダは残さない(move 済みなら元の場所へ戻す)。
        if mode == "move" and dest.exists() and not src.exists():
            shutil.move(str(dest), src)
        shutil.rmtree(book_dir, ignore_errors=True)
        raise
    return {**book, "dir": book_dir.name}
