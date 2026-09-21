from fastapi import APIRouter
from pydantic import BaseModel

from .. import scanner, search
from ..db import connect
from ..resolve import get_root

router = APIRouter(prefix="/roots")


class ScanRequest(BaseModel):
    root: str


@router.post("/scan")
def scan_root(req: ScanRequest) -> dict:
    """管理ルート直下の本フォルダを走査して索引を更新する。"""
    root = get_root(req.root)
    return scanner.scan(root)


@router.get("/works")
def list_works(root: str) -> dict:
    """ルートに登録済みの本の一覧を返す(既読位置付き)。"""
    r = get_root(root)
    with connect(r) as conn:
        rows = conn.execute(
            """
            SELECT w.id, w.rel_path, w.title, w.author, w.writing_mode, w.page_count, w.page_direction,
                   w.spread_offset, w.sort_index, w.added_at, w.last_opened_at,
                   COALESCE(rs.last_page, 0) AS last_page,
                   COALESCE(rs.completed, 0) AS completed,
                   (SELECT GROUP_CONCAT(name, char(10)) FROM (
                        SELECT t.name FROM work_tags wt
                        JOIN tags t ON t.id = wt.tag_id
                        WHERE wt.work_id = w.id
                        ORDER BY t.name COLLATE NOCASE
                    )) AS tags_concat
            FROM works w
            LEFT JOIN reading_state rs ON rs.work_id = w.id
            ORDER BY w.title COLLATE NOCASE
            """
        ).fetchall()
    works = []
    for row in rows:
        d = dict(row)
        raw = d.pop("tags_concat")
        d["tags"] = raw.split("\n") if raw else []
        works.append(d)
    return {"works": works}


class OrderRequest(BaseModel):
    root: str
    ids: list[str]  # 手動順の work_id 列(先頭が最上位)


@router.put("/works-order")
def set_works_order(req: OrderRequest) -> dict:
    """手動並び替えの順序を保存する。"""
    r = get_root(req.root)
    with connect(r) as conn:
        for i, wid in enumerate(req.ids):
            conn.execute("UPDATE works SET sort_index = ? WHERE id = ?", (i, wid))
        conn.commit()
    return {"ok": True}


@router.get("/search")
def search_works(root: str, q: str) -> dict:
    """タイトル・あらすじ・ページ説明を横断検索し、該当 work_id を返す。"""
    r = get_root(root)
    return {"work_ids": search.search(r, q)}
