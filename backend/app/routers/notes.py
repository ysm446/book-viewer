from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import jobs, notes, transcribe
from ..resolve import get_root

router = APIRouter(prefix='/works')


@router.get('/{work_id}/notes')
def get_notes(work_id: str, root: str, page: int = Query(0, ge=0),
              chapter: int | None = None, mode: Literal['all', 'chapter', 'through'] = 'all'):
    try:
        return notes.get(get_root(root), work_id, page, chapter, mode)
    except (notes.NotesError, transcribe.TranscribeError) as e:
        raise HTTPException(400, str(e)) from e


class Request(BaseModel):
    root: str


@router.post('/{work_id}/notes')
def create_notes(work_id: str, body: Request):
    try:
        return jobs.enqueue(str(get_root(body.root)), work_id, 'notes')
    except jobs.NotFound as e:
        raise HTTPException(404, str(e)) from e


class Changes(Request):
    spoiler_guard: bool | None = None
    fact_id: str | None = None
    description: str | None = Field(None, min_length=1, max_length=1000)
    hidden: bool | None = None
    merge_subject: str | None = Field(None, max_length=120)
    merge_target: str | None = Field(None, max_length=120)
    revealed: int | None = Field(None, ge=0)
    clear_merges: bool = False
    restore_hidden: bool = False


@router.patch('/{work_id}/notes')
def change_notes(work_id: str, body: Changes):
    try:
        notes.change(get_root(body.root), work_id, body.model_dump(exclude={'root'}, exclude_none=True))
        return {'ok': True}
    except (notes.NotesError, transcribe.TranscribeError) as e:
        raise HTTPException(400, str(e)) from e
