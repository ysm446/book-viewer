from fastapi import APIRouter
from pydantic import BaseModel

from .. import jobs

router = APIRouter(prefix="/queue")


@router.get("")
def queue_state() -> dict:
    """ジョブキューの状態(実行中・待機中・最近終わったもの)。"""
    return jobs.snapshot()


class CancelRequest(BaseModel):
    work_id: str


@router.post("/cancel")
def queue_cancel(body: CancelRequest) -> dict:
    """その本のジョブを止める(待機中は取り消し、実行中は次の区切りで中断)。"""
    return jobs.cancel(body.work_id)


@router.post("/clear")
def queue_clear() -> dict:
    """待機中のジョブをすべて取り消し、実行中のものも中断する。"""
    return jobs.clear()
