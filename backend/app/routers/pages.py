from fastapi import APIRouter, HTTPException, Response

from .. import archive, thumbnails
from ..resolve import get_root, resolve_archive

router = APIRouter(prefix="/works")


@router.get("/{work_id}/thumbnail")
def get_thumbnail(work_id: str, root: str) -> Response:
    """作品サムネイル(先頭ページの縮小・キャッシュ)を返す。"""
    r = get_root(root)
    path = resolve_archive(r, work_id)
    try:
        thumb = thumbnails.get_or_create(r, work_id, path)
        data = thumb.read_bytes()
    except (OSError, IndexError):
        raise HTTPException(status_code=404, detail="サムネイルを生成できません")
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.get("/{work_id}/pages")
def list_pages(work_id: str, root: str) -> dict:
    """ページ数とエントリ名一覧を返す。"""
    r = get_root(root)
    path = resolve_archive(r, work_id)
    names = archive.list_images(path)
    return {"count": len(names), "names": names}


@router.get("/{work_id}/pages/{index}")
def get_page(work_id: str, index: int, root: str) -> Response:
    """index 番目(0 始まり)のページ画像を返す。"""
    r = get_root(root)
    path = resolve_archive(r, work_id)
    try:
        data, media_type = archive.read_page(path, index)
    except IndexError:
        raise HTTPException(status_code=404, detail="ページが存在しません")
    return Response(
        content=data,
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=3600"},
    )
