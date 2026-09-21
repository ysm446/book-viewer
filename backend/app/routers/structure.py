from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import analysis_queue, structure, transcribe
from ..resolve import get_root

router = APIRouter(prefix="/works")


@router.get("/{work_id}/structure")
def get_structure(work_id: str, root: str) -> dict:
    """章立て(章ごとの範囲・節・要約)と本全体の要約を返す。"""
    r = get_root(root)
    try:
        return structure.get_structure(r, work_id)
    except (transcribe.TranscribeError, structure.StructureError) as e:
        raise HTTPException(status_code=400, detail=str(e))


class StructureRequest(BaseModel):
    root: str
    redo: bool = False  # 章立てから作り直す(既存の要約も消える)


@router.post("/{work_id}/structure")
def enqueue_structure(work_id: str, body: StructureRequest) -> dict:
    """章立てと要約の作成を解析キューに積む(LLM の読み込みが必要)。"""
    get_root(body.root)
    return analysis_queue.enqueue(body.root, [work_id], 0, kind="structure", force=body.redo)
