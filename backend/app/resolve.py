"""ルーター共通のリクエスト解決ヘルパー。"""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException

from .db import connect


def get_root(root: str) -> Path:
    p = Path(root)
    if not p.is_dir():
        raise HTTPException(status_code=404, detail=f"管理ルートが見つかりません: {root}")
    return p


def resolve_archive(root: Path, work_id: str) -> Path:
    """work_id からアーカイブの実パスを解決する。"""
    with connect(root) as conn:
        row = conn.execute("SELECT rel_path FROM works WHERE id = ?", (work_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="作品が見つかりません")
    path = root / row["rel_path"]
    if not path.is_file():
        raise HTTPException(status_code=410, detail="アーカイブファイルが存在しません")
    return path
