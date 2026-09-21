"""本の章立て(目次)と要約(M4)。

- 章立て: 文字起こしした本文から、目次ページ・各ページの見出し・章の扉(図の中の文字)を
  ページ番号付きで集め、LLM に章(level 1)と節(level 2)の開始ページを決めさせる。
  結果は book.json の "chapters" に保存する(本フォルダが正本)。
- 要約: 章(level 1)ごとに本文を LLM で要約し summaries/ch-p0030.md(章の開始ページ)に、
  章の要約から本全体の要約を作って summaries/book.md に保存する。
  長い章は分けて要約してからまとめる(コンテキスト長の制約のため)。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import library, llm, transcribe
from .progress import Cancelled, clear_progress, set_progress

SUMMARIES_DIRNAME = "summaries"
BOOK_SUMMARY = "book.md"
# 章の要約を作ったときの章の範囲。範囲が変わった(章立てを直した)章の要約は使わない。
SUMMARY_INDEX = "index.json"

# 章の要約で一度に渡す本文の既定の上限(文字数)。コンテキスト長が分かればそこから決める。
_DEFAULT_CHUNK_CHARS = 12000
# 章立ての判断材料に使う、ページごとの図の文字・見出しの上限。
_OUTLINE_LINE_CHARS = 160
# 本文がこれより少ないページは、図の文字(章の扉など)も判断材料に入れる。
_SPARSE_PAGE_CHARS = 150
_TOC_MAX_CHARS = 6000

_CHAPTERS_SCHEMA = {
    "type": "object",
    "properties": {
        "chapters": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "page": {"type": "integer"},
                    "level": {"type": "integer"},
                },
                "required": ["title", "page", "level"],
            },
        }
    },
    "required": ["chapters"],
}

_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")


class StructureError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _book_dir(root: Path, work_id: str) -> tuple[Path, dict]:
    book_dir, _, _ = transcribe._book(root, work_id)
    book = library.read_book(book_dir)
    if book is None:
        raise StructureError("book.json を読めません")
    return book_dir, book


def _page_texts(root: Path, work_id: str) -> dict[int, str]:
    """文字起こし済みページの Markdown(0 始まりのページ番号 → 本文)。"""
    out = {}
    for p in transcribe.done_pages(root, work_id):
        out[p] = transcribe.read_text(root, work_id, p) or ""
    return out


# ---- 章立て ----------------------------------------------------------------


def _outline(texts: dict[int, str]) -> list[str]:
    """ページごとの見出しと、本文の少ないページの図の文字を 1 行ずつ並べる。"""
    lines = []
    for p in sorted(texts):
        md = texts[p]
        heads = [ln[2:].strip() for ln in md.splitlines() if ln.startswith("## ")]
        body_chars = sum(
            len(ln) for ln in md.splitlines() if ln.strip() and not ln.startswith(("## ", "!["))
        )
        figs = [m.group(1) for m in _IMAGE_RE.finditer(md) if m.group(1).strip()]
        parts = []
        if heads:
            parts.append("見出し: " + " / ".join(heads))
        if figs and body_chars < _SPARSE_PAGE_CHARS:
            parts.append("図の文字: " + " / ".join(figs))
        if parts:
            lines.append(f"p.{p + 1} " + "  ".join(parts)[:_OUTLINE_LINE_CHARS])
    return lines


def _toc(texts: dict[int, str], page_count: int) -> str:
    """本の前のほうにある目次ページ(「目次」を含むページとその後の数ページ)の文字。"""
    front = [p for p in sorted(texts) if p < max(10, page_count // 5)]
    start = next((p for p in front if re.search(r"目\s*次|もくじ|CONTENTS", texts[p])), None)
    if start is None:
        return ""
    chunks = []
    for p in [q for q in front if start <= q <= start + 4]:
        text = _IMAGE_RE.sub(lambda m: m.group(1), texts[p])
        chunks.append(f"(p.{p + 1})\n{text.strip()}")
    return "\n".join(chunks)[:_TOC_MAX_CHARS]


def _chapter_prompt(title: str, page_count: int, toc: str, outline: list[str]) -> str:
    return "\n".join(
        [
            f"以下は本『{title}』(全 {page_count} ページ)を文字起こしした情報です。この本の章立てを作ってください。",
            "",
            "## 目次(文字起こし。誤字や順序の乱れがあることがある)",
            toc or "(目次ページは見つかりませんでした)",
            "",
            "## ページごとの見出しと、図として読み取られた文字(p. はページ番号)",
            *outline,
            "",
            "条件:",
            "- 章(level 1)と、その中の節(level 2)を、本の順に並べる",
            "- 章は「はじめに」「序章」「第1章」「おわりに」「付録」など本の大きな区切り。"
            "目次があれば目次の章に合わせる",
            "- page は、その章・節が始まるページ番号(上の一覧の p. の数字)。章の扉のページがあればそこ",
            "- 表紙・目次ページ・奥付・図の説明は章にしない",
            "- title は目次や見出しの表記を使う。明らかな読み取りの誤りは直してよい。"
            "章は「第1章 ○○」のように番号も付ける",
            '- 出力は JSON のみ: {"chapters": [{"title": "...", "page": 8, "level": 1}, ...]}',
        ]
    )


def _normalize_chapters(raw: list, page_count: int, fill_front: bool = True) -> list[dict]:
    """章立てを整える(範囲外・重複を除き、ページ順に並べる)。page は 1 始まりで受け取る。

    fill_front=True なら、最初の章より前のページを「前付け」の章で補う(LLM の章立て用)。
    """
    out: list[dict] = []
    seen = set()
    for c in raw:
        if not isinstance(c, dict):
            continue
        title = str(c.get("title") or "").strip()
        try:
            page = int(c.get("page")) - 1
        except (TypeError, ValueError):
            continue
        level = 2 if c.get("level") == 2 else 1
        if not title or not 0 <= page < page_count or (title, page) in seen:
            continue
        seen.add((title, page))
        out.append({"title": title, "page": page, "level": level})
    out.sort(key=lambda c: (c["page"], c["level"]))
    if not any(c["level"] == 1 for c in out):
        # 章が取れなければ、節を章として扱う。
        for c in out:
            c["level"] = 1
    first = next((c["page"] for c in out if c["level"] == 1), None)
    if first is None:
        return [{"title": "本文", "page": 0, "level": 1}]
    if first > 0 and fill_front:
        out.insert(0, {"title": "前付け(表紙・目次など)", "page": 0, "level": 1})
    return out


def detect_chapters(root: Path, work_id: str, base_url: str) -> list[dict]:
    """章立てを LLM で作って book.json に保存し、返す。"""
    book_dir, book = _book_dir(root, work_id)
    texts = _page_texts(root, work_id)
    if not texts:
        raise StructureError("文字起こしされたページがありません。先に文字起こしをしてください。")
    page_count = int(book.get("page_count") or max(texts) + 1)
    prompt = _chapter_prompt(book.get("title") or "", page_count, _toc(texts, page_count), _outline(texts))
    out = llm.chat(
        base_url,
        [{"role": "user", "content": prompt}],
        temperature=0.1,
        think=False,
        json_schema=_CHAPTERS_SCHEMA,
    )
    chapters = _normalize_chapters(llm.parse_json(out).get("chapters") or [], page_count)
    book["chapters"] = chapters
    book["chapters_updated_at"] = _now()
    library.write_book(book_dir, book)
    return chapters


def chapter_ranges(chapters: list[dict], page_count: int) -> list[dict]:
    """章(level 1)ごとに {title, start, end, sections} を返す(end は含む、0 始まり)。"""
    tops = [c for c in chapters if c.get("level", 1) == 1]
    out = []
    for i, c in enumerate(tops):
        end = tops[i + 1]["page"] - 1 if i + 1 < len(tops) else page_count - 1
        end = max(end, c["page"])
        sections = [
            {"title": s["title"], "page": s["page"]}
            for s in chapters
            if s.get("level") == 2 and c["page"] <= s["page"] <= end
        ]
        out.append({"title": c["title"], "start": c["page"], "end": end, "sections": sections})
    return out


# ---- 要約 --------------------------------------------------------------------


def _summary_path(book_dir: Path, start: int) -> Path:
    return book_dir / SUMMARIES_DIRNAME / f"ch-p{start + 1:04d}.md"


def _load_index(book_dir: Path) -> dict:
    try:
        data = json.loads((book_dir / SUMMARIES_DIRNAME / SUMMARY_INDEX).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _save_index(book_dir: Path, index: dict) -> None:
    path = book_dir / SUMMARIES_DIRNAME / SUMMARY_INDEX
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _valid_summary(book_dir: Path, index: dict, ch: dict) -> str | None:
    """章の要約。作ったときと章の範囲が違えば(章立てを直した)None。"""
    path = _summary_path(book_dir, ch["start"])
    if not path.is_file():
        return None
    made = index.get(path.name)
    if made and (made.get("start"), made.get("end")) != (ch["start"], ch["end"]):
        return None
    return path.read_text(encoding="utf-8").strip()


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".md.tmp")
    tmp.write_text(text.strip() + "\n", encoding="utf-8")
    tmp.replace(path)


def _chunks(pages: list[tuple[int, str]], limit: int) -> list[list[tuple[int, str]]]:
    """(ページ, 本文) を limit 文字ごとのまとまりに分ける(ページの途中では切らない)。"""
    out: list[list[tuple[int, str]]] = [[]]
    used = 0
    for p, text in pages:
        if out[-1] and used + len(text) > limit:
            out.append([])
            used = 0
        out[-1].append((p, text))
        used += len(text)
    return [c for c in out if c]


def _joined(pages: list[tuple[int, str]]) -> str:
    return "\n".join(f"--- p.{p + 1} ---\n{t}" for p, t in pages)


def _summarize_chapter(
    base_url: str, book_title: str, ch: dict, pages: list[tuple[int, str]], limit: int
) -> str:
    head = f"本『{book_title}』の「{ch['title']}」(p.{ch['start'] + 1}〜p.{ch['end'] + 1})"
    rules = [
        "- 最初に 2〜4 文で、この章で何が述べられているかの概要",
        "- 続けて「**要点**」として箇条書きを 3〜6 個",
        "- 最後に「**キーワード**」として重要な用語を 3〜8 個、読点区切りで 1 行",
        "- 本文に書かれていないことは書かない。見出し(#)は使わない",
    ]
    parts = _chunks(pages, limit)
    if len(parts) == 1:
        prompt = "\n".join(
            [
                f"以下は{head}の本文です(文字起こし。図は [図: キャプション] と表記)。",
                "この章の要約を日本語の Markdown で書いてください。",
                *rules,
                "",
                _joined(parts[0]),
            ]
        )
        return llm.chat(base_url, [{"role": "user", "content": prompt}], temperature=0.3, think=False)

    # 長い章は、まとまりごとに要点を出してから章の要約にまとめる。
    notes = []
    for part in parts:
        prompt = "\n".join(
            [
                f"以下は{head}の一部(p.{part[0][0] + 1}〜p.{part[-1][0] + 1})の本文です。",
                "この部分の要点を日本語の箇条書きで 5〜10 個にまとめてください。本文に無いことは書かない。",
                "",
                _joined(part),
            ]
        )
        note = llm.chat(base_url, [{"role": "user", "content": prompt}], temperature=0.3, think=False)
        notes.append(f"(p.{part[0][0] + 1}〜p.{part[-1][0] + 1} の要点)\n{note.strip()}")
    prompt = "\n".join(
        [
            f"以下は{head}を部分ごとに要約したメモです。",
            "これをもとに、この章全体の要約を日本語の Markdown で書いてください。",
            *rules,
            "",
            *notes,
        ]
    )
    return llm.chat(base_url, [{"role": "user", "content": prompt}], temperature=0.3, think=False)


def _summarize_book(base_url: str, book_title: str, chapter_summaries: list[tuple[dict, str]]) -> str:
    body = "\n\n".join(
        f"### {ch['title']}(p.{ch['start'] + 1}〜p.{ch['end'] + 1})\n{s.strip()}"
        for ch, s in chapter_summaries
    )
    prompt = "\n".join(
        [
            f"以下は本『{book_title}』の各章の要約です。",
            "本全体の要約を日本語の Markdown で書いてください。",
            "- 最初に 3〜5 文で、この本が何について、どういう流れで述べているかの概要",
            "- 続けて「**各章**」として、章ごとに 1 行ずつ役割を箇条書き",
            "- 章の要約に無いことは書かない。見出し(#)は使わない",
            "",
            body,
        ]
    )
    return llm.chat(base_url, [{"role": "user", "content": prompt}], temperature=0.3, think=False)


def run(
    root: Path,
    work_id: str,
    base_url: str,
    *,
    redo: bool = False,
    ctx_size: int | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> None:
    """章立て(無ければ、または redo なら作り直し)→ 章ごとの要約 → 本全体の要約。

    redo=False なら、既にある章の要約は作り直さない(文字起こしを進めたあとの追加分だけ作る)。
    """
    book_dir, book = _book_dir(root, work_id)
    title = book.get("title") or ""
    page_count = int(book.get("page_count") or 0)
    limit = (
        min(max(int(ctx_size * 0.6), 4000), 40000) if ctx_size else _DEFAULT_CHUNK_CHARS
    )
    set_progress(work_id, 0, 1, "chapters")
    try:
        chapters = book.get("chapters")
        if redo or not chapters:
            if redo:
                # 章の区切りが変わると古い要約は合わなくなるので消す。
                for f in (book_dir / SUMMARIES_DIRNAME).glob("*"):
                    f.unlink(missing_ok=True)
            chapters = detect_chapters(root, work_id, base_url)
        ranges = chapter_ranges(chapters, page_count)
        texts = _page_texts(root, work_id)
        index = _load_index(book_dir)
        total = len(ranges) + 1
        done: list[tuple[dict, str]] = []
        for n, ch in enumerate(ranges):
            if cancel_check and cancel_check():
                raise Cancelled()
            set_progress(work_id, n, total, "summary")
            path = _summary_path(book_dir, ch["start"])
            pages = [
                (p, transcribe.plain_for_llm(texts[p]))
                for p in range(ch["start"], ch["end"] + 1)
                if p in texts and transcribe.plain_for_llm(texts[p])
            ]
            if not pages:
                continue
            existing = None if redo else _valid_summary(book_dir, index, ch)
            if existing:
                done.append((ch, existing))
                continue
            summary = _summarize_chapter(base_url, title, ch, pages, limit)
            _write(path, summary)
            index[path.name] = {"start": ch["start"], "end": ch["end"]}
            _save_index(book_dir, index)
            done.append((ch, summary))
        if cancel_check and cancel_check():
            raise Cancelled()
        set_progress(work_id, len(ranges), total, "book")
        if done:
            _write(book_dir / SUMMARIES_DIRNAME / BOOK_SUMMARY, _summarize_book(base_url, title, done))
    finally:
        clear_progress(work_id)


def get_structure(root: Path, work_id: str) -> dict:
    """画面・チャット用の章立てと要約。章立てが無ければ chapters は空。"""
    book_dir, book = _book_dir(root, work_id)
    page_count = int(book.get("page_count") or 0)
    index = _load_index(book_dir)
    chapters = []
    for ch in chapter_ranges(book.get("chapters") or [], page_count):
        ch["summary"] = _valid_summary(book_dir, index, ch)
        chapters.append(ch)
    book_path = book_dir / SUMMARIES_DIRNAME / BOOK_SUMMARY
    return {
        "chapters": chapters,
        # 編集用の章立て(章と節をページ順に。page は 0 始まり)
        "entries": book.get("chapters") or [],
        "book_summary": book_path.read_text(encoding="utf-8").strip() if book_path.is_file() else None,
        "transcribed": len(transcribe.done_pages(root, work_id)),
        "page_count": page_count,
    }


def save_chapters(root: Path, work_id: str, entries: list[dict]) -> dict:
    """手で直した章立てを保存する(entries の page は 0 始まり)。

    範囲が変わった章の要約と、本全体の要約は古くなるので消す(「要約を更新」で作り直せる)。
    """
    book_dir, book = _book_dir(root, work_id)
    page_count = int(book.get("page_count") or 0)
    raw = []
    for e in entries:
        try:
            raw.append({**e, "page": int(e.get("page")) + 1})
        except (TypeError, ValueError):
            continue
    chapters = _normalize_chapters(raw, page_count, fill_front=False)
    old = {(c["start"], c["end"]) for c in chapter_ranges(book.get("chapters") or [], page_count)}
    new = chapter_ranges(chapters, page_count)
    book["chapters"] = chapters
    book["chapters_updated_at"] = _now()
    library.write_book(book_dir, book)

    if {(c["start"], c["end"]) for c in new} != old:
        index = _load_index(book_dir)
        keep = {_summary_path(book_dir, c["start"]).name for c in new if _valid_summary(book_dir, index, c)}
        for f in (book_dir / SUMMARIES_DIRNAME).glob("ch-p*.md"):
            if f.name not in keep:
                f.unlink(missing_ok=True)
                index.pop(f.name, None)
        _save_index(book_dir, index)
        (book_dir / SUMMARIES_DIRNAME / BOOK_SUMMARY).unlink(missing_ok=True)
    return get_structure(root, work_id)
