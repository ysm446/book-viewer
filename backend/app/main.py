"""FastAPI アプリ本体。Electron main から uvicorn で起動される。"""

from __future__ import annotations

import hmac
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__, embedding, llm_server
from .routers import chat, health, library, llm, pages, queue, roots, structure, text, works


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    yield
    # バックエンド終了時に llama-server(会話用・埋め込み用)も止める。
    llm_server.stop()
    embedding.stop()


app = FastAPI(title="Book Viewer Backend", version=__version__, lifespan=_lifespan)

# Electron main が起動時に生成して環境変数で渡す合言葉。ブラウザで開いた無関係なページから
# localhost の API(任意パスの取り込み・削除・実行ファイルの起動)を叩かれないようにする。
# 単体起動(デバッグ)で未設定なら検査しない。
_TOKEN = os.environ.get("BOOK_VIEWER_TOKEN", "")


@app.middleware("http")
async def _require_token(request: Request, call_next):
    if _TOKEN and request.method != "OPTIONS" and request.url.path != "/api/health":
        given = request.headers.get("x-book-viewer-token") or request.query_params.get("token") or ""
        if not hmac.compare_digest(given, _TOKEN):
            return JSONResponse({"detail": "token が違います"}, status_code=401)
    return await call_next(request)


# ローカルデスクトップアプリ用途のため、localhost からのアクセスを広く許可する(合言葉で守る)。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api")
app.include_router(roots.router, prefix="/api")
app.include_router(library.router, prefix="/api")
app.include_router(works.router, prefix="/api")
app.include_router(pages.router, prefix="/api")
app.include_router(text.router, prefix="/api")
app.include_router(structure.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(llm.router, prefix="/api")
app.include_router(queue.router, prefix="/api")
