"""FastAPI アプリ本体。Electron main から uvicorn で起動される。"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__, embedding, llm_server
from .routers import analysis, health, library, pages, roots, structure, text, works

app = FastAPI(title="Book Viewer Backend", version=__version__)


@app.on_event("shutdown")
def _shutdown() -> None:
    # バックエンド終了時に llama-server(会話用・埋め込み用)も止める。
    llm_server.stop()
    embedding.stop()

# ローカルデスクトップアプリ用途のため、localhost からのアクセスを広く許可する。
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
app.include_router(analysis.router, prefix="/api")
