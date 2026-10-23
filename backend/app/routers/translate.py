from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import jobs, transcribe, translate
from ..resolve import get_root

router = APIRouter(prefix="/works")


@router.get("/{work_id}/translation")
def get_translation(work_id: str, root: str) -> dict:
    """アプリ用の本文のブロックの並びに合わせた日本語訳(未訳のブロックは null)。"""
    r = get_root(root)
    try:
        return translate.get_translation(r, work_id)
    except transcribe.TranscribeError as e:
        raise HTTPException(status_code=400, detail=str(e))


class TranslateRequest(BaseModel):
    root: str
    redo: bool = False  # 訳したブロックも訳し直す(訳語表は残す)
    blocks: list[int] | None = None  # このブロック(content.json の添字)だけ訳し直す


@router.post("/{work_id}/translate")
def enqueue_translate(work_id: str, body: TranslateRequest) -> dict:
    """日本語訳をジョブキューに積む(LLM の読み込みが必要)。"""
    get_root(body.root)
    try:
        extra = {"blocks": body.blocks} if body.blocks is not None else None
        return jobs.enqueue(body.root, work_id, "translate", force=body.redo, extra=extra)
    except jobs.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
