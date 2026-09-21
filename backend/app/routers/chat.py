import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import chat, llm, llm_server
from ..db import connect
from ..resolve import get_root

router = APIRouter()


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    root: str
    messages: list[ChatMessage]
    current_page: int | None = None
    include_image: bool = False
    page_focus: bool = False
    system_prompt: str | None = None
    think: bool = False
    # 本文を渡す上限(文字数)。None なら既定(chat.CHAT_CONTEXT_CHARS)。
    context_chars: int | None = None
    # 本文検索を使うときの {server_path, models_dir}(埋め込み用の llama-server の起動に使う)。
    search: dict | None = None


def _chat_setup(work_id: str, body: ChatRequest):
    """チャット共通の前処理: ルート解決・モデル確認・(必要なら)アーカイブ解決。"""
    r = get_root(body.root)
    st = llm_server.status()
    if not (st["running"] and st["base_url"]):
        raise HTTPException(status_code=400, detail="モデルが読み込まれていません。")
    archive_path = None
    if body.include_image and body.current_page is not None:
        with connect(r) as conn:
            row = conn.execute(
                "SELECT rel_path, page_count FROM works WHERE id = ?", (work_id,)
            ).fetchone()
        # ページが範囲外なら画像添付を諦める(read_page の IndexError → 500 を防ぐ)。
        if row and 0 <= body.current_page < row["page_count"]:
            p = r / row["rel_path"]
            if p.is_file():
                archive_path = p
    return r, st["base_url"], archive_path


@router.post("/works/{work_id}/chat")
def work_chat(work_id: str, body: ChatRequest) -> dict:
    """本について会話する(読んだ範囲の本文・章の要約・本文検索を文脈に、任意で現在ページ画像を添付)。"""
    r, base_url, archive_path = _chat_setup(work_id, body)
    try:
        reply = chat.chat_about_work(
            r,
            work_id,
            base_url,
            [m.model_dump() for m in body.messages],
            current_page=body.current_page,
            archive_path=archive_path,
            include_image=body.include_image,
            page_focus=body.page_focus,
            system_prompt=body.system_prompt,
            think=body.think,
            context_chars=body.context_chars,
            search_opts=body.search,
        )
    except llm.LlmError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"reply": reply}


@router.post("/works/{work_id}/chat/stream")
def work_chat_stream(work_id: str, body: ChatRequest) -> StreamingResponse:
    """work_chat のストリーム版。SSE(text/event-stream)で差分を送る。"""
    r, base_url, archive_path = _chat_setup(work_id, body)
    msgs = [m.model_dump() for m in body.messages]

    def gen():
        try:
            for delta in chat.chat_about_work_stream(
                r,
                work_id,
                base_url,
                msgs,
                current_page=body.current_page,
                archive_path=archive_path,
                include_image=body.include_image,
                page_focus=body.page_focus,
                system_prompt=body.system_prompt,
                think=body.think,
                context_chars=body.context_chars,
                search_opts=body.search,
            ):
                yield f"data: {json.dumps(delta, ensure_ascii=False)}\n\n"
        except llm.LlmError as e:
            yield f"data: {json.dumps({'type': 'error', 'text': str(e)}, ensure_ascii=False)}\n\n"
        except Exception as e:  # noqa: BLE001 - 予期しない例外でもエラーと [DONE] を必ず届ける
            yield f"data: {json.dumps({'type': 'error', 'text': str(e)}, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/works/{work_id}/chat/suggest")
def work_chat_suggest(work_id: str, body: ChatRequest) -> dict:
    """チャット末尾の候補チップに混ぜる、状況に合った質問を作る。

    候補は無くても会話はできるので、モデル未起動・生成失敗はエラーにせず
    空配列を返す(UI は固定の候補だけを出す)。
    """
    r = get_root(body.root)
    st = llm_server.status()
    if not (st["running"] and st["base_url"]):
        return {"questions": []}
    try:
        questions = chat.suggest_chat_questions(
            r,
            work_id,
            st["base_url"],
            [m.model_dump() for m in body.messages],
            current_page=body.current_page,
        )
    except Exception:  # noqa: BLE001 - 候補は付加機能なので、失敗しても会話を止めない
        return {"questions": []}
    return {"questions": questions}
