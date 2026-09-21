"""本のサムネイルの生成とキャッシュ。

先頭ページを縮小し、<管理ルート>/.book-viewer/thumbnails/{work_id}.jpg に保存する。
work_id は内容フィンガープリントなので、内容が変わらない限りキャッシュは有効。
"""

from __future__ import annotations

import io
from pathlib import Path

from PIL import Image

from . import archive
from .config import thumbnails_dir

# サムネイルの最大サイズ(縦長前提)。アスペクト比は維持する。
THUMB_MAX = (360, 512)


def thumbnail_path(root: Path, work_id: str) -> Path:
    return thumbnails_dir(root) / f"{work_id}.jpg"


def get_or_create(root: Path, work_id: str, archive_path: Path) -> Path:
    """キャッシュがあれば返し、無ければ先頭ページから生成する。"""
    out = thumbnail_path(root, work_id)
    if out.exists():
        return out
    data, _ = archive.read_page(archive_path, 0)
    with Image.open(io.BytesIO(data)) as img:
        img = img.convert("RGB")
        img.thumbnail(THUMB_MAX)
        img.save(out, "JPEG", quality=82)
    return out
