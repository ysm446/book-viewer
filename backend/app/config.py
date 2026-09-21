"""管理ルートごとのデータ配置を解決するユーティリティ。

方針(docs/plan/plan.md):
- ルート固有データは <管理ルート>/.book-viewer/ に集約する。
- 旧名 .manga-viewer/ が残っていれば初回アクセス時に .book-viewer/ へリネームする。
- library.db / thumbnails / config.json をその下に置く。
"""

from __future__ import annotations

from pathlib import Path

DATA_DIRNAME = ".book-viewer"
LEGACY_DATA_DIRNAME = ".manga-viewer"  # manga-viewer 時代の旧名(移行用)
DB_FILENAME = "library.db"
THUMBNAILS_DIRNAME = "thumbnails"

# スキャン対象とするアーカイブ拡張子。
ARCHIVE_EXTENSIONS = {".zip", ".cbz", ".pdf"}

# 連番画像として扱う拡張子(初期: jpg / png / webp)。
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}


def data_dir(root: Path) -> Path:
    """ルート直下の .book-viewer ディレクトリを返す(無ければ作成)。"""
    d = root / DATA_DIRNAME
    legacy = root / LEGACY_DATA_DIRNAME
    if not d.exists() and legacy.is_dir():
        legacy.rename(d)
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path(root: Path) -> Path:
    return data_dir(root) / DB_FILENAME


def thumbnails_dir(root: Path) -> Path:
    d = data_dir(root) / THUMBNAILS_DIRNAME
    d.mkdir(parents=True, exist_ok=True)
    return d
