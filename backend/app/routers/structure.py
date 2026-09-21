from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import embedding, jobs, structure, transcribe
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
    """章立てと要約の作成をジョブキューに積む(LLM の読み込みが必要)。"""
    get_root(body.root)
    try:
        return jobs.enqueue(body.root, work_id, "structure", force=body.redo)
    except jobs.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


class ChapterEntry(BaseModel):
    title: str
    page: int  # 0 始まり
    level: int = 1  # 1 = 章 / 2 = 節


class ChaptersUpdate(BaseModel):
    root: str
    chapters: list[ChapterEntry]


@router.put("/{work_id}/structure/chapters")
def save_chapters(work_id: str, body: ChaptersUpdate) -> dict:
    """手で直した章立てを保存する。範囲が変わった章の要約は消える。"""
    r = get_root(body.root)
    if jobs.is_busy(work_id):
        raise HTTPException(status_code=409, detail="この本の処理が進行中です。終わってから保存してください")
    try:
        return structure.save_chapters(r, work_id, [c.model_dump() for c in body.chapters])
    except (transcribe.TranscribeError, structure.StructureError) as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{work_id}/index")
def index_status(work_id: str, root: str, models_dir: str = "") -> dict:
    """本文検索の索引の状態と、使える埋め込みモデル。"""
    r = get_root(root)
    model = embedding.find_model(models_dir)
    return {**embedding.status(r, work_id, models_dir), "embedding_model": model.stem if model else None}


class IndexRequest(BaseModel):
    root: str
    server_path: str = ""
    models_dir: str = ""


@router.post("/{work_id}/index")
def enqueue_index(work_id: str, body: IndexRequest) -> dict:
    """本文検索の索引づくりをジョブキューに積む(埋め込み用の llama-server を別に起動する)。"""
    get_root(body.root)
    try:
        return jobs.enqueue(
            body.root,
            work_id,
            "index",
            extra={"server_path": body.server_path, "models_dir": body.models_dir},
        )
    except jobs.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
