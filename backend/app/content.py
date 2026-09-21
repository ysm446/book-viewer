"""アプリ用の本文(原本のページ割りから切り離した、ひと続きの本文)。

本文の正本は原本のページ単位の pages/0001.md …(transcribe.py)のまま残し、そこから
段落・見出し・図などのブロックの並びを作って本フォルダの content.json に保存する。
テキスト表示(アプリがページを組み直す)・チャット・要約・本文検索・全文検索は、
ページのファイルではなくこの本文を材料にする。

- ページをまたいで切れた段落は 1 つのブロックにつなぐ(3 ページ以上にまたがってもよい)。
- 各ブロックは原本の何ページから始まるか(page)を持つ。つないだブロックは、続きが
  どのページの分かを cont([ページ, md の中の開始位置])に残す。読書位置・しおり・
  根拠のページ・ネタバレ防止はこの原本のページ番号で扱う。
- 章(level 1)の始まりのブロックには break を付ける(表示で改ページする)。

content.json は生成物。ページのファイルや章立てが変わっていれば、読むときに作り直す。
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from . import library, transcribe

CONTENT_FILENAME = "content.json"
SCHEMA = 1

_FENCE_LINE_RE = re.compile(r"^```", re.MULTILINE)
_KINDS = (
    (re.compile(r"^#{1,6}\s"), "heading"),
    (re.compile(r"^(!\[|\[図[:：])"), "figure"),
    (re.compile(r"^\|"), "table"),
    (re.compile(r"^([-*+]\s|\d+[.)]\s)"), "list"),
    (re.compile(r"^>"), "quote"),
    (re.compile(r"^```"), "code"),
    (re.compile(r"^\$\$"), "math"),
)


def _kind(block: str) -> str:
    for pattern, kind in _KINDS:
        if pattern.match(block):
            return kind
    return "p"


def split_blocks(markdown: str) -> list[str]:
    """ページの Markdown をブロック(空行区切り)に分ける。

    コードブロックの中の空行では分けない。見出しの行の直後に空行なしで本文が続くときは、
    見出しだけを別のブロックにする。
    """
    out: list[str] = []
    in_fence = False
    for part in transcribe._BLOCK_RE.split(markdown.strip()):
        part = part.strip("\n")
        if not part.strip():
            continue
        if in_fence:
            out[-1] += "\n\n" + part
        else:
            first, _, rest = part.partition("\n")
            if first.startswith("#") and rest.strip():
                out.extend([first.strip(), rest.strip("\n")])
            else:
                out.append(part)
        if len(_FENCE_LINE_RE.findall(part)) % 2 == 1:
            in_fence = not in_fence
    return out


def _last_page(block: dict) -> int:
    cont = block.get("cont")
    return cont[-1][0] if cont else block["page"]


def build_blocks(pages: dict[int, str], heads: dict[int, bool | None], chapters: list[dict]) -> list[dict]:
    """ページごとの Markdown → ブロックの並び。

    heads はページ先頭の段落が字下げなしか(pages/0001.json の head_continues。分からなければ None)。
    """
    blocks: list[dict] = []
    for page in sorted(pages):
        for k, part in enumerate(split_blocks(pages[page])):
            prev = blocks[-1] if blocks else None
            if (
                k == 0
                and prev is not None
                and _last_page(prev) == page - 1
                and transcribe.joins_previous(prev["md"], part, heads.get(page))
            ):
                tail = prev["md"].rstrip()
                head = part.strip()
                # 英単語どうしが切れていたら空白を入れる(日本語は詰める)。
                ascii_word = lambda c: c.isascii() and c.isalnum()  # noqa: E731
                sep = " " if ascii_word(tail[-1:]) and ascii_word(head[:1]) else ""
                prev.setdefault("cont", []).append([page, len(tail) + len(sep)])
                prev["md"] = tail + sep + head
                continue
            blocks.append({"page": page, "kind": _kind(part), "md": part})
    # 章の始まり: その章の開始ページ以降で最初に始まるブロック。
    starts = sorted({int(c["page"]) for c in chapters if c.get("level", 1) == 1})
    i = 0
    for start in starts:
        while i < len(blocks) and blocks[i]["page"] < start:
            i += 1
        if i < len(blocks):
            blocks[i]["break"] = True
    return blocks


def _signature(book_dir: Path, done: list[int], chapters: list[dict]) -> str:
    """材料(ページの本文・補助情報・章立て)の指紋。変わっていたら作り直す。"""
    h = hashlib.sha1(f"schema {SCHEMA}\n".encode())
    for p in done:
        for path in (transcribe.page_path(book_dir, p), transcribe.meta_path(book_dir, p)):
            try:
                st = path.stat()
                h.update(f"{path.name} {st.st_mtime_ns} {st.st_size}\n".encode())
            except OSError:
                h.update(f"{path.name} -\n".encode())
    h.update(json.dumps(chapters, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    return h.hexdigest()


def load(root: Path, work_id: str) -> dict:
    """アプリ用の本文 {schema, signature, built_at, pages_done, blocks} を返す。

    content.json が無いか、材料が変わっていれば作り直して保存する。
    本フォルダ方式の本でなければ transcribe.TranscribeError。
    """
    book_dir, _, _ = transcribe._book(root, work_id)
    book = library.read_book(book_dir) or {}
    chapters = [c for c in book.get("chapters") or [] if isinstance(c, dict) and "page" in c]
    done = transcribe.done_pages(root, work_id)
    signature = _signature(book_dir, done, chapters)
    path = book_dir / CONTENT_FILENAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("signature") == signature:
            return data
    except (OSError, ValueError):
        pass
    pages = {p: transcribe.page_path(book_dir, p).read_text(encoding="utf-8") for p in done}
    heads = {p: transcribe._read_meta(book_dir, p).get("head_continues") for p in done}
    data = {
        "schema": SCHEMA,
        "signature": signature,
        "built_at": datetime.now(timezone.utc).isoformat(),
        "pages_done": len(done),
        "blocks": build_blocks(pages, heads, chapters),
    }
    try:
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        tmp.replace(path)
    except OSError:
        pass  # 書けなくても表示・検索はできる(次に読むときにまた作る)
    return data


def _upto(block: dict, max_page: int | None) -> str:
    """ブロックの本文。max_page より先のページから取り込んだ続きは落とす。"""
    if max_page is not None:
        for page, offset in block.get("cont") or []:
            if page > max_page:
                return block["md"][:offset].rstrip()
    return block["md"]


def page_texts(root: Path, work_id: str, max_page: int | None = None) -> dict[int, str]:
    """原本のページ番号 → そのページから始まるブロックの本文(Markdown)。

    ページをまたぐ段落は始まりのページ側に入る。max_page を渡すと、そのページまでの本文だけを
    返す(先のページの文は持ち込まない。チャットのネタバレ防止)。
    """
    out: dict[int, list[str]] = {}
    for block in load(root, work_id)["blocks"]:
        if max_page is not None and block["page"] > max_page:
            break
        out.setdefault(block["page"], []).append(_upto(block, max_page))
    return {p: "\n\n".join(parts) for p, parts in out.items()}


def continued_pages(root: Path, work_id: str) -> dict[int, int]:
    """先のページの書き出しを取り込んだブロックで終わるページ → そのブロックが終わるページ。"""
    return {b["page"]: _last_page(b) for b in load(root, work_id)["blocks"] if b.get("cont")}
