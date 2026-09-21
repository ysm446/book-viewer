from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import jobs, transcribe
from ..resolve import get_root

router = APIRouter(prefix="/works")


@router.get("/{work_id}/text")
def text_status(work_id: str, root: str) -> dict:
    """文字起こし済みのページ番号(0 始まり)を返す。"""
    r = get_root(root)
    try:
        return {"pages": transcribe.done_pages(r, work_id)}
    except transcribe.TranscribeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{work_id}/text/{index}")
def page_text(work_id: str, index: int, root: str) -> dict:
    """ページの本文(Markdown)・確信度の低い行・手で直したか。未処理なら markdown は null。"""
    r = get_root(root)
    try:
        page = transcribe.read_page(r, work_id, index)
    except transcribe.TranscribeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return page or {"markdown": None, "low": [], "edited": False}


class TextUpdate(BaseModel):
    root: str
    markdown: str


@router.put("/{work_id}/text/{index}")
def save_page_text(work_id: str, index: int, body: TextUpdate) -> dict:
    """手で直した本文を保存する(全ページのやり直しでは上書きされなくなる)。"""
    r = get_root(body.root)
    try:
        return transcribe.save_text(r, work_id, index, body.markdown)
    except transcribe.TranscribeError as e:
        raise HTTPException(status_code=400, detail=str(e))


class TranscribeRequest(BaseModel):
    root: str
    pages: list[int] | None = None  # 省略時は未処理の全ページ
    force: bool = False  # 既存の Markdown も作り直す
    engine: str = "yomitoku"  # 'yomitoku' / 'vlm'


@router.post("/{work_id}/transcribe")
def enqueue_transcribe(work_id: str, body: TranscribeRequest) -> dict:
    """文字起こしをジョブキューに積む。"""
    get_root(body.root)
    if body.engine not in transcribe.ENGINES:
        raise HTTPException(status_code=400, detail="engine は yomitoku / vlm のいずれか")
    try:
        return jobs.enqueue(
            body.root, work_id, "transcribe", pages=body.pages, force=body.force, engine=body.engine
        )
    except jobs.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{work_id}/figures/{name}")
def figure(work_id: str, name: str, root: str) -> FileResponse:
    """本文中の図(本フォルダの figures/ にある切り抜き画像)を返す。"""
    r = get_root(root)
    try:
        path = transcribe.figure_path(r, work_id, name)
    except transcribe.TranscribeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if path is None:
        raise HTTPException(status_code=404, detail="図が見つかりません")
    return FileResponse(path, media_type="image/png")
