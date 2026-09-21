from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import llama_release, llm, llm_server

router = APIRouter()


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
