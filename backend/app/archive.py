"""zip / cbz / pdf アーカイブ内のページ画像を扱う。

zip / cbz は連番画像をそのまま取り出す。pdf は PDFium(pypdfium2)で
ページをラスタライズして JPEG として返すため、呼び出し側は形式を意識しない。
"""

from __future__ import annotations

import io
import re
import threading
import zipfile
from pathlib import Path

from .config import IMAGE_EXTENSIONS

_NUM_RE = re.compile(r"(\d+)")

# PDF ページのラスタライズ長辺(px)。見開き表示でも十分な画質と速度のバランス。
_PDF_RENDER_LONG_SIDE = 2000
# PDFium はスレッドセーフではないため、PDF 操作は直列化する。
_PDF_LOCK = threading.Lock()


def _is_pdf(path: Path) -> bool:
    return path.suffix.lower() == ".pdf"


def _pdfium():
    try:
        import pypdfium2 as pdfium
    except ImportError as e:  # pragma: no cover
        raise OSError(
            "PDF 対応には pypdfium2 が必要です (backend/requirements.txt を再インストールしてください)"
        ) from e
    return pdfium


def _pdf_page_count(path: Path) -> int:
    pdfium = _pdfium()
    with _PDF_LOCK:
        try:
            doc = pdfium.PdfDocument(str(path))
        except pdfium.PdfiumError as e:
            # 壊れた PDF は zip の BadZipFile と同様にスキップ対象へ寄せる。
            raise OSError(f"PDF を開けません: {path.name}") from e
        try:
            return len(doc)
        finally:
            doc.close()


def _pdf_read_page(path: Path, index: int) -> tuple[bytes, str]:
    pdfium = _pdfium()
    with _PDF_LOCK:
        try:
            doc = pdfium.PdfDocument(str(path))
        except pdfium.PdfiumError as e:
            raise OSError(f"PDF を開けません: {path.name}") from e
        try:
            if index < 0 or index >= len(doc):
                raise IndexError(f"page index out of range: {index} (count={len(doc)})")
            page = doc[index]
            width, height = page.get_size()
            scale = _PDF_RENDER_LONG_SIDE / max(width, height)
            image = page.render(scale=scale).to_pil()
        finally:
            doc.close()
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=90)
    return buf.getvalue(), "image/jpeg"


def natural_key(name: str):
    """連番を数値として比較する自然順ソートキー。"""
    parts = _NUM_RE.split(name.lower())
    return [int(p) if p.isdigit() else p for p in parts]


def _is_image(name: str) -> bool:
    suffix = Path(name).suffix.lower()
    return suffix in IMAGE_EXTENSIONS


def _is_metadata_entry(name: str) -> bool:
    """macOS の zip に入る __MACOSX/ や ._xxx(AppleDouble)は画像ではないので除く。"""
    parts = name.replace("\\", "/").split("/")
    return "__MACOSX" in parts or parts[-1].startswith("._")


def _image_names(zf: zipfile.ZipFile) -> list[str]:
    names = [
        info.filename
        for info in zf.infolist()
        if not info.is_dir() and _is_image(info.filename) and not _is_metadata_entry(info.filename)
    ]
    names.sort(key=natural_key)
    return names


def list_images(archive_path: Path) -> list[str]:
    """アーカイブ内のページエントリ名を自然順で返す。PDF は疑似名を返す。"""
    if _is_pdf(archive_path):
        return [f"page_{i + 1:04d}" for i in range(_pdf_page_count(archive_path))]
    with zipfile.ZipFile(archive_path) as zf:
        return _image_names(zf)


def page_count(archive_path: Path) -> int:
    if _is_pdf(archive_path):
        return _pdf_page_count(archive_path)
    return len(list_images(archive_path))


# zip のページ名の並び((パス, 更新時刻, サイズ) → 名前)。ページ送り・文字起こしでページごとに
# 全エントリを並べ直さないために覚えておく。
_NAMES_CACHE_MAX = 16
_names_cache: dict[tuple[str, int, int], list[str]] = {}
_names_lock = threading.Lock()


def _cached_image_names(archive_path: Path, zf: zipfile.ZipFile) -> list[str]:
    st = archive_path.stat()
    key = (str(archive_path), st.st_mtime_ns, st.st_size)
    with _names_lock:
        names = _names_cache.get(key)
    if names is None:
        names = _image_names(zf)
        with _names_lock:
            _names_cache[key] = names
            while len(_names_cache) > _NAMES_CACHE_MAX:
                del _names_cache[next(iter(_names_cache))]
    return names


def read_page(archive_path: Path, index: int) -> tuple[bytes, str]:
    """index 番目(0 始まり)のページ画像のバイト列と MIME タイプを返す。"""
    if _is_pdf(archive_path):
        return _pdf_read_page(archive_path, index)
    with zipfile.ZipFile(archive_path) as zf:
        names = _cached_image_names(archive_path, zf)
        if index < 0 or index >= len(names):
            raise IndexError(f"page index out of range: {index} (count={len(names)})")
        name = names[index]
        data = zf.read(name)
    return data, _media_type(name)


def _media_type(name: str) -> str:
    suffix = Path(name).suffix.lower()
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".bmp": "image/bmp",
    }.get(suffix, "application/octet-stream")
