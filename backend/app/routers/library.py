from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import fingerprint, library, scanner
from ..resolve import get_root

router = APIRouter(prefix="/library")


def _book_ids(root: Path) -> set[str]:
    """取り込み済み(本フォルダがある)本の ID。重複判定に使う。"""
    ids: set[str] = set()
    for book_dir in library.iter_book_dirs(root):
        book = library.read_book(book_dir)
        if book is not None:
            ids.add(book["id"])
    return ids


def _describe(path: Path, known: set[str]) -> dict:
    """取り込みダイアログに出す 1 ファイル分の情報。"""
    info = {
        "path": str(path),
        "name": path.name,
        "title": library.title_from_filename(path),
        "size": 0,
        "duplicate": False,
        "error": None,
    }
    try:
        info["size"] = path.stat().st_size
        info["duplicate"] = fingerprint.compute(path) in known
    except OSError as e:
        info["error"] = f"ファイルを読めません: {e}"
    return info


class InspectRequest(BaseModel):
    root: str
    paths: list[str]


@router.post("/inspect")
def inspect(req: InspectRequest) -> dict:
    """取り込み候補のファイルについて、書名の初期値と重複の有無を返す。"""
    r = get_root(req.root)
    known = _book_ids(r)
    return {"files": [_describe(Path(p), known) for p in req.paths]}


@router.get("/loose")
def loose(root: str) -> dict:
    """管理ルート内で、まだ本フォルダに取り込まれていないアーカイブを返す。"""
    r = get_root(root)
    known = _book_ids(r)
    return {"files": [_describe(p, known) for p in library.iter_loose_archives(r)]}


class ImportItem(BaseModel):
    path: str
    title: str | None = None
    author: str = ""
    writing_mode: str = "horizontal"


class ImportRequest(BaseModel):
    root: str
    items: list[ImportItem]
    mode: str = "copy"  # 'copy' / 'move'


@router.post("/import")
def import_books(req: ImportRequest) -> dict:
    """アーカイブを本フォルダとして取り込む。1 件ずつ結果を返し、失敗しても続行する。"""
    if req.mode not in ("copy", "move"):
        raise HTTPException(status_code=400, detail="mode は copy / move のいずれか")
    r = get_root(req.root)
    known = _book_ids(r)
    results = []
    for item in req.items:
        try:
            book = library.import_archive(
                r,
                Path(item.path),
                mode=req.mode,
                title=item.title,
                author=item.author,
                writing_mode=item.writing_mode,
                known_ids=known,
            )
        except library.LibraryError as e:
            results.append({"path": item.path, "ok": False, "error": str(e)})
            continue
        except OSError as e:
            results.append({"path": item.path, "ok": False, "error": f"保存に失敗しました: {e}"})
            continue
        known.add(book["id"])
        results.append(
            {"path": item.path, "ok": True, "id": book["id"], "title": book["title"], "dir": book["dir"]}
        )
    return {"results": results, "scan": scanner.scan(r)}
