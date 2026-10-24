from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from .. import tts

router = APIRouter(prefix="/tts")


@router.get("/status")
def tts_status(server_dir: str = "", models_dir: str = "", base_url: str = "") -> dict:
    """読み上げサーバーの状態(導入済みか・動いているか・インストールの進み具合)。"""
    return tts.status(server_dir, models_dir, base_url)


class ServerRequest(BaseModel):
    server_dir: str = ""
    models_dir: str = ""
    base_url: str = ""


@router.post("/start")
def tts_start(body: ServerRequest) -> dict:
    """サーバーを起動する(待たずに返す。準備ができたかは status で見る)。"""
    try:
        return tts.start(body.server_dir, body.models_dir, body.base_url)
    except tts.TtsError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/stop")
def tts_stop() -> dict:
    return tts.stop()


@router.post("/install")
def tts_install(body: ServerRequest) -> dict:
    """Irodori-TTS-Server を git clone + uv sync で入れる(背後で実行。進み具合は status の install)。"""
    try:
        return tts.install(body.server_dir)
    except tts.TtsError as e:
        raise HTTPException(status_code=400, detail=str(e))


class SpeakRequest(BaseModel):
    base_url: str = ""
    text: str
    caption: str = ""
    ref_wav: str = ""
    seed: int | None = None


@router.post("/speak")
def tts_speak(body: SpeakRequest) -> Response:
    """本文を音声にして返す(opus。サーバーが出せなければ wav)。"""
    try:
        data, media_type = tts.synthesize(
            body.base_url, body.text, caption=body.caption, ref_wav=body.ref_wav, seed=body.seed
        )
    except tts.TtsError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return Response(content=data, media_type=media_type, headers={"Cache-Control": "no-store"})


# 参照音声として読める形式(Chromium が再生できるもの)
_AUDIO_TYPES = {
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".m4a": "audio/mp4",
}


@router.get("/ref-audio")
def tts_ref_audio(path: str) -> FileResponse:
    """設定の参照音声(ローカルの音声ファイル)を試聴のために返す。"""
    p = Path(path.strip()).expanduser()
    media = _AUDIO_TYPES.get(p.suffix.lower())
    if media is None:
        raise HTTPException(status_code=400, detail=f"音声ファイルではありません: {p.name}")
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"参照音声が見つかりません: {p}")
    return FileResponse(str(p), media_type=media, headers={"Cache-Control": "no-store"})
