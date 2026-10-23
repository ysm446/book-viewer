from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import jobs, transcribe, translate
from ..resolve import get_root

router = APIRouter()


@router.get("/works/{work_id}/translation")
def get_translation(work_id: str, root: str, style: str = translate.DEFAULT_STYLE) -> dict:
    """アプリ用の本文のブロックの並びに合わせた、訳の種類 style の日本語訳(未訳のブロックは null)。"""
    r = get_root(root)
    try:
        return translate.get_translation(r, work_id, style)
    except (transcribe.TranscribeError, translate.TranslateError) as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/works/{work_id}/translation/live")
def get_translation_live(work_id: str) -> dict:
    """翻訳中のまとまりの、保存前の訳(LLM が書いている途中の訳文を含む)。翻訳していなければ blocks は空。"""
    return translate.get_live(work_id)


class TranslateRequest(BaseModel):
    root: str
    style: str = translate.DEFAULT_STYLE  # 訳の種類
    redo: bool = False  # 訳したブロックも訳し直す(訳語表は残す)
    stale: bool = False  # 指示を書き直す前に訳したブロックだけ訳し直す
    blocks: list[int] | None = None  # このブロック(content.json の添字)だけ訳し直す


@router.post("/works/{work_id}/translate")
def enqueue_translate(work_id: str, body: TranslateRequest) -> dict:
    """日本語訳をジョブキューに積む(LLM の読み込みが必要)。"""
    r = get_root(body.root)
    try:
        translate.get_style(r, body.style)
    except translate.TranslateError as e:
        raise HTTPException(status_code=400, detail=str(e))
    extra: dict = {"style": body.style, "stale": body.stale}
    if body.blocks is not None:
        extra["blocks"] = body.blocks
    try:
        return jobs.enqueue(body.root, work_id, "translate", force=body.redo, extra=extra)
    except jobs.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/translation-styles")
def list_styles(root: str) -> dict:
    """訳の種類(組み込みと、管理ルートに保存した自分で作った種類)。"""
    return {"styles": translate.list_styles(get_root(root))}


class StyleEntry(BaseModel):
    id: str | None = None  # 新しく作る種類は省略(保存時に付ける)
    name: str
    instructions: str


class StylesUpdate(BaseModel):
    root: str
    styles: list[StyleEntry]  # 自分で作った種類だけ(並び順のまま保存する)


@router.put("/translation-styles")
def save_styles(body: StylesUpdate) -> dict:
    """自分で作った訳の種類を保存する。一覧から外した種類は消える(本に保存した訳のファイルは残る)。"""
    r = get_root(body.root)
    try:
        return {"styles": translate.save_styles(r, [s.model_dump() for s in body.styles])}
    except translate.TranslateError as e:
        raise HTTPException(status_code=400, detail=str(e))
