from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import analysis_queue, transcribe
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
    """ページの本文(Markdown)を返す。未処理なら markdown は null。"""
    r = get_root(root)
    try:
        return {"markdown": transcribe.read_text(r, work_id, index)}
    except transcribe.TranscribeError as e:
        raise HTTPException(status_code=400, detail=str(e))


class TranscribeRequest(BaseModel):
    root: str
    pages: list[int] | None = None  # 省略時は未処理の全ページ
    force: bool = False  # 既存の Markdown も作り直す


@router.post("/{work_id}/transcribe")
def enqueue_transcribe(work_id: str, body: TranscribeRequest) -> dict:
    """文字起こしを解析キューに積む。"""
    get_root(body.root)
    return analysis_queue.enqueue(
        body.root, [work_id], 0, pages=body.pages, kind="transcribe", force=body.force
    )
