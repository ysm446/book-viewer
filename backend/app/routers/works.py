from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import jobs, library, search, thumbnails
from ..db import connect
from ..resolve import get_root, resolve_archive

router = APIRouter(prefix="/works")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# Windows で使えない文字 + パス区切り。リネームは同一フォルダ内に限定する。
_INVALID_FILENAME_CHARS = set('<>:"/\\|?*')


class FilenameUpdate(BaseModel):
    name: str  # 新しいファイル名(拡張子なし)


@router.put("/{work_id}/filename")
def rename_work(work_id: str, root: str, body: FilenameUpdate) -> dict:
    """書名を変更する。

    本フォルダ方式なら book.json の書名を変え、フォルダ名も追従させる。
    それ以前の本はアーカイブのファイル名を変更する(拡張子・フォルダは維持)。
    """
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="名前が空です")
    if jobs.is_busy(work_id):
        # 文字起こし中にフォルダを動かすと、旧名のフォルダへ書き戻して孤児が残る。
        raise HTTPException(status_code=409, detail="この本の処理が進行中です。終わってから名前を変えてください")
    r = get_root(root)
    old_path = resolve_archive(r, work_id)
    book_dir = library.book_dir_for(r, old_path.relative_to(r).as_posix())
    if book_dir is not None:
        try:
            new_dir = library.rename_book(r, book_dir, name)
        except library.LibraryError as e:
            raise HTTPException(status_code=409, detail=str(e))
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"名前の変更に失敗しました: {e}")
        rel = (new_dir / old_path.relative_to(book_dir)).relative_to(r).as_posix()
        with connect(r) as conn:
            conn.execute(
                "UPDATE works SET rel_path = ?, title = ? WHERE id = ?", (rel, name, work_id)
            )
            # 索引づくりは別接続で works を読むので、先に確定させる。
            conn.commit()
            search.update_index(conn, r, work_id, book_dir=new_dir)
            conn.commit()
        return {"ok": True, "title": name, "rel_path": rel}

    if any(c in _INVALID_FILENAME_CHARS for c in name) or name.rstrip(". ") != name:
        raise HTTPException(status_code=400, detail="ファイル名に使えない文字が含まれています")
    new_path = old_path.with_name(name + old_path.suffix)
    if new_path != old_path:
        if new_path.exists():
            raise HTTPException(status_code=409, detail="同名のファイルが既にあります")
        try:
            old_path.rename(new_path)
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"リネームに失敗しました: {e}")
    rel = new_path.relative_to(r).as_posix()
    with connect(r) as conn:
        conn.execute(
            "UPDATE works SET rel_path = ?, title = ? WHERE id = ?", (rel, name, work_id)
        )
        conn.commit()
        search.update_index(conn, r, work_id)
        conn.commit()
    return {"ok": True, "title": name, "rel_path": rel}


@router.delete("/{work_id}")
def delete_work(work_id: str, root: str) -> dict:
    """本フォルダ(旧方式ならアーカイブ)をごみ箱へ移動し、DB からも削除する。

    タグ・しおり等は CASCADE で消える。
    """
    if jobs.is_busy(work_id):
        raise HTTPException(status_code=409, detail="この本の処理が進行中です。止めてから削除してください")
    r = get_root(root)
    with connect(r) as conn:
        row = conn.execute("SELECT rel_path FROM works WHERE id = ?", (work_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="本が見つかりません")
    path = library.book_dir_for(r, row["rel_path"]) or r / row["rel_path"]
    if path.exists():
        try:
            from send2trash import send2trash
        except ImportError:
            raise HTTPException(
                status_code=500,
                detail="send2trash が必要です (backend/requirements.txt を再インストールしてください)",
            )
        try:
            send2trash(str(path))
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"削除に失敗しました: {e}")
    with connect(r) as conn:
        conn.execute("DELETE FROM works WHERE id = ?", (work_id,))
        search.remove_index(conn, work_id)
        conn.commit()
    thumbnails.thumbnail_path(r, work_id).unlink(missing_ok=True)
    return {"ok": True}


@router.get("/{work_id}")
def get_work(work_id: str, root: str) -> dict:
    r = get_root(root)
    with connect(r) as conn:
        row = conn.execute("SELECT * FROM works WHERE id = ?", (work_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="本が見つかりません")
        state = conn.execute(
            "SELECT last_page, completed, updated_at FROM reading_state WHERE work_id = ?",
            (work_id,),
        ).fetchone()
        tags = [
            r["name"]
            for r in conn.execute(
                "SELECT t.name FROM work_tags wt JOIN tags t ON t.id = wt.tag_id "
                "WHERE wt.work_id = ? ORDER BY t.name COLLATE NOCASE",
                (work_id,),
            ).fetchall()
        ]
    work = dict(row)
    work["reading_state"] = dict(state) if state else {"last_page": 0, "completed": 0}
    work["tags"] = tags
    return work


class ReadingStateUpdate(BaseModel):
    last_page: int
    completed: bool = False


@router.put("/{work_id}/reading-state")
def update_reading_state(work_id: str, root: str, body: ReadingStateUpdate) -> dict:
    """既読位置を保存する(続きから読む)。"""
    r = get_root(root)
    with connect(r) as conn:
        if conn.execute("SELECT 1 FROM works WHERE id = ?", (work_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="本が見つかりません")
        conn.execute(
            """
            INSERT INTO reading_state (work_id, last_page, completed, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(work_id) DO UPDATE SET
                last_page = excluded.last_page,
                completed = excluded.completed,
                updated_at = excluded.updated_at
            """,
            (work_id, body.last_page, int(body.completed), _now()),
        )
        conn.execute(
            "UPDATE works SET last_opened_at = ? WHERE id = ?", (_now(), work_id)
        )
        conn.commit()
    return {"ok": True}


class DirectionUpdate(BaseModel):
    direction: str  # 'default' / 'rtl' / 'ltr'


@router.put("/{work_id}/direction")
def update_direction(work_id: str, root: str, body: DirectionUpdate) -> dict:
    """本ごとの読み進め方向の上書きを保存する。"""
    if body.direction not in ("default", "rtl", "ltr"):
        raise HTTPException(status_code=400, detail="direction は default / rtl / ltr のいずれか")
    r = get_root(root)
    with connect(r) as conn:
        if conn.execute("SELECT 1 FROM works WHERE id = ?", (work_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="本が見つかりません")
        conn.execute(
            "UPDATE works SET page_direction = ? WHERE id = ?", (body.direction, work_id)
        )
        conn.commit()
    return {"ok": True}


class WritingModeUpdate(BaseModel):
    writing_mode: str  # 'horizontal' / 'vertical'


@router.put("/{work_id}/writing-mode")
def update_writing_mode(work_id: str, root: str, body: WritingModeUpdate) -> dict:
    """本文の書字方向(横書き / 縦書き)を変更する。本フォルダなら book.json も更新する。"""
    if body.writing_mode not in library.WRITING_MODES:
        raise HTTPException(status_code=400, detail="writing_mode は horizontal / vertical のいずれか")
    r = get_root(root)
    with connect(r) as conn:
        row = conn.execute("SELECT rel_path FROM works WHERE id = ?", (work_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="本が見つかりません")
        book_dir = library.book_dir_for(r, row["rel_path"])
        if book_dir is not None:
            book = library.read_book(book_dir)
            if book is not None:
                book["writing_mode"] = body.writing_mode
                library.write_book(book_dir, book)
        conn.execute(
            "UPDATE works SET writing_mode = ? WHERE id = ?", (body.writing_mode, work_id)
        )
        conn.commit()
    return {"ok": True}


class SpreadOffsetUpdate(BaseModel):
    offset: str  # 'default' / '0' / '1'


@router.put("/{work_id}/spread-offset")
def update_spread_offset(work_id: str, root: str, body: SpreadOffsetUpdate) -> dict:
    """本ごとの見開きペア境界ずらしを保存する。"""
    if body.offset not in ("default", "0", "1"):
        raise HTTPException(status_code=400, detail="offset は default / 0 / 1 のいずれか")
    r = get_root(root)
    with connect(r) as conn:
        if conn.execute("SELECT 1 FROM works WHERE id = ?", (work_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="本が見つかりません")
        conn.execute(
            "UPDATE works SET spread_offset = ? WHERE id = ?", (body.offset, work_id)
        )
        conn.commit()
    return {"ok": True}


class TagAdd(BaseModel):
    name: str


@router.post("/{work_id}/tags")
def add_tag(work_id: str, root: str, body: TagAdd) -> dict:
    """本にタグを付ける(タグが無ければ作成)。"""
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="タグ名が空です")
    r = get_root(root)
    with connect(r) as conn:
        if conn.execute("SELECT 1 FROM works WHERE id = ?", (work_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="本が見つかりません")
        conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (name,))
        tag_id = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()["id"]
        conn.execute(
            "INSERT OR IGNORE INTO work_tags (work_id, tag_id) VALUES (?, ?)",
            (work_id, tag_id),
        )
        conn.commit()
    return {"ok": True, "name": name}


@router.delete("/{work_id}/tags")
def remove_tag(work_id: str, root: str, name: str) -> dict:
    """本からタグを外す(タグ自体は残す)。"""
    r = get_root(root)
    with connect(r) as conn:
        conn.execute(
            "DELETE FROM work_tags WHERE work_id = ? "
            "AND tag_id = (SELECT id FROM tags WHERE name = ?)",
            (work_id, name),
        )
        conn.commit()
    return {"ok": True}


@router.get("/{work_id}/bookmarks")
def list_bookmarks(work_id: str, root: str) -> dict:
    r = get_root(root)
    with connect(r) as conn:
        rows = conn.execute(
            "SELECT id, page, note, created_at FROM bookmarks WHERE work_id = ? ORDER BY page",
            (work_id,),
        ).fetchall()
    return {"bookmarks": [dict(row) for row in rows]}


class BookmarkCreate(BaseModel):
    page: int
    note: str | None = None


@router.post("/{work_id}/bookmarks")
def add_bookmark(work_id: str, root: str, body: BookmarkCreate) -> dict:
    r = get_root(root)
    with connect(r) as conn:
        if conn.execute("SELECT 1 FROM works WHERE id = ?", (work_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="本が見つかりません")
        cur = conn.execute(
            "INSERT INTO bookmarks (work_id, page, note, created_at) VALUES (?, ?, ?, ?)",
            (work_id, body.page, body.note, _now()),
        )
        conn.commit()
        bookmark_id = cur.lastrowid
    return {"id": bookmark_id}


@router.delete("/{work_id}/bookmarks/{bookmark_id}")
def delete_bookmark(work_id: str, bookmark_id: int, root: str) -> dict:
    r = get_root(root)
    with connect(r) as conn:
        conn.execute(
            "DELETE FROM bookmarks WHERE id = ? AND work_id = ?", (bookmark_id, work_id)
        )
        conn.commit()
    return {"ok": True}
