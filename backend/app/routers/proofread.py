from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import jobs, proofread, transcribe
from ..resolve import get_root

router = APIRouter(prefix="/works")


@router.get("/{work_id}/proofread")
def get_summary(work_id: str, root: str) -> dict:
    """誤字の補正の状況 {total, checked, fixes}(対象の段落数・読んだ段落数・当てている補正の数)。"""
    try:
        return proofread.summary(get_root(root), work_id)
    except (transcribe.TranscribeError, proofread.ProofreadError) as e:
        raise HTTPException(status_code=400, detail=str(e))


class ProofreadRequest(BaseModel):
    root: str
    redo: bool = False  # 読んだ段落も読み直す(元に戻した補正は当て直さない)


@router.post("/{work_id}/proofread")
def enqueue_proofread(work_id: str, body: ProofreadRequest) -> dict:
    """誤字の補正をジョブキューに積む(LLM の読み込みが必要)。"""
    try:
        return jobs.enqueue(body.root, work_id, "proofread", force=body.redo)
    except jobs.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


class FixToggle(BaseModel):
    root: str
    block: int  # content.json のブロックの添字
    pos: int  # 補正の位置(ブロックの md の中)
    off: bool  # True で元に戻す、False で当て直す


@router.put("/{work_id}/proofread/fix")
def toggle_fix(work_id: str, body: FixToggle) -> dict:
    """補正 1 か所を元に戻す・当て直す。"""
    try:
        proofread.set_off(get_root(body.root), work_id, body.block, body.pos, body.off)
    except (transcribe.TranscribeError, proofread.ProofreadError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}
