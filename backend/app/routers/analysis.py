import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import analysis as analysis_mod
from .. import analysis_queue, llama_release, llm, llm_server
from ..db import connect
from ..resolve import get_root

router = APIRouter()


@router.get("/works/{work_id}/analysis")
def get_analysis(work_id: str, root: str) -> dict:
    r = get_root(root)
    result = analysis_mod.get_analysis(r, work_id)
    pages = analysis_mod.get_analyzed_pages(r, work_id)
    return {"analysis": result, "analyzed_pages": pages}


@router.get("/works/{work_id}/page-analysis")
def page_analysis(work_id: str, root: str, page: int) -> dict:
    """指定ページの解析結果(無ければ null)。リーダー下部表示用。"""
    r = get_root(root)
    return {"analysis": analysis_mod.get_page_analysis(r, work_id, page)}


@router.get("/works/{work_id}/analysis/progress")
def analysis_progress(work_id: str) -> dict:
    """解析中の進捗(無ければ idle)。解析POSTと並行で取得される。"""
    p = analysis_mod.get_progress(work_id)
    return p or {"phase": "idle", "current": 0, "total": 0}


class EnqueueRequest(BaseModel):
    root: str
    work_ids: list[str]
    sample_pages: int = 10
    focus_page: int | None = None
    pages: list[int] | None = None
    system_prompt: str | None = None
    all_pages: bool = False
    context_count: int = 0
    summary_only: bool = False
    use_story_summary: bool = False
    story_every: int = 5


@router.post("/analysis/enqueue")
def analysis_enqueue(body: EnqueueRequest) -> dict:
    """選んだ作品を解析キューに積む(全ページ / 未解析を増分 / 指定ページ / あらすじのみ再生成)。"""
    get_root(body.root)
    return analysis_queue.enqueue(
        body.root,
        body.work_ids,
        body.sample_pages,
        body.focus_page,
        body.pages,
        body.system_prompt,
        body.all_pages,
        body.context_count,
        body.summary_only,
        body.use_story_summary,
        body.story_every,
    )


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
    # 本文を渡す上限(文字数)。None なら既定(analysis.CHAT_CONTEXT_CHARS)。
    context_chars: int | None = None


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
    """本について会話する(本文の読んだ範囲を文脈に、任意で現在ページ画像を添付)。"""
    r, base_url, archive_path = _chat_setup(work_id, body)
    try:
        reply = analysis_mod.chat_about_work(
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
            for delta in analysis_mod.chat_about_work_stream(
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
        questions = analysis_mod.suggest_chat_questions(
            r,
            work_id,
            st["base_url"],
            [m.model_dump() for m in body.messages],
            current_page=body.current_page,
        )
    except Exception:  # noqa: BLE001 - 候補は付加機能なので、失敗しても会話を止めない
        return {"questions": []}
    return {"questions": questions}


@router.get("/analysis/queue")
def analysis_queue_state() -> dict:
    return analysis_queue.snapshot()


class CancelRequest(BaseModel):
    work_id: str


@router.post("/analysis/cancel")
def analysis_cancel(body: CancelRequest) -> dict:
    return analysis_queue.cancel(body.work_id)


@router.post("/analysis/clear")
def analysis_clear() -> dict:
    return analysis_queue.clear()


class PingRequest(BaseModel):
    base_url: str


@router.post("/llm/ping")
def llm_ping(body: PingRequest) -> dict:
    """LLM サーバへの到達性を確認する。"""
    return {"ok": llm.ping(body.base_url)}


@router.get("/llm/models")
def llm_models(models_dir: str = "") -> dict:
    """モデル置き場の一覧と現在のサーバ状態を返す。

    models_dir 未指定(空)なら既定の models/ を走査する。
    走査に使ったフォルダも返し、UI で「どこを見ているか」を示せるようにする。
    """
    d = llm_server.resolve_models_dir(models_dir)
    return {
        "models": llm_server.scan_models(d),
        "status": llm_server.status(),
        "models_dir": str(d),
        "exists": d.is_dir(),
    }


@router.get("/llm/status")
def llm_status() -> dict:
    return llm_server.status()


class LoadRequest(BaseModel):
    model_path: str
    mmproj_path: str | None = None
    server_path: str = ""
    ctx_size: int = 4096
    base_url: str = "http://127.0.0.1:8080/v1"


@router.post("/llm/load")
def llm_load(body: LoadRequest) -> dict:
    """選んだモデルで llama-server を起動する。"""
    try:
        return llm_server.load(
            body.server_path,
            body.model_path,
            body.mmproj_path,
            body.ctx_size,
            body.base_url,
        )
    except (FileNotFoundError, RuntimeError, TimeoutError, OSError) as e:
        # OSError: 壊れた実行ファイル指定(WinError 193 等)でも 500 にしない。
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/llm/unload")
def llm_unload() -> dict:
    return llm_server.stop()


@router.get("/llm/builds")
def llm_builds() -> dict:
    """展開済みの llama.cpp ビルド一覧。"""
    return llama_release.installed_builds()


@router.get("/llm/builds/latest")
def llm_builds_latest() -> dict:
    """最新リリースのダウンロード候補一覧(GitHub)。"""
    try:
        return llama_release.list_latest()
    except OSError as e:
        raise HTTPException(status_code=502, detail=f"リリース情報を取得できません: {e}")


class DownloadBuildRequest(BaseModel):
    url: str
    name: str
    cudart_url: str | None = None


@router.post("/llm/builds/download")
def llm_builds_download(body: DownloadBuildRequest) -> dict:
    """選んだビルドをダウンロードして展開する。"""
    try:
        return llama_release.download_build(body.url, body.name, body.cudart_url)
    except (OSError, ValueError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=str(e))
