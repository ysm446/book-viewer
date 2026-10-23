"""英語の本の日本語訳(対訳表示用)。

アプリ用の本文(content.json)のブロック(段落・見出し・箇条など)を、ローカル LLM で日本語に訳す。
原文は文に分け、訳は「原文の何文目から何文目まで ↔ 訳文」の組で持つ(英語 2 文を日本語 1 文にまとめる、
などの言い換えを許すため)。表示はこの組を文 / 段落 / 節の単位にまとめ直すので、単位を変えても訳し直さない。

保存先は本フォルダの translation/ja.json(生成物。消せば訳し直す)。ブロックは本文の指紋(md の SHA-1)で
引くので、content.json を作り直しても本文が同じブロックの訳は残る。本文を直したブロックだけ訳し直しになる。
固有名詞などの訳語は glossary に溜め、次のまとまりに渡して訳をそろえる。
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import content, library, llm, transcribe
from .progress import Cancelled, clear_progress, set_progress

TRANSLATION_DIRNAME = "translation"
TRANSLATION_FILE = "ja.json"
SCHEMA = 1

# 訳すブロックの種類(図・表・コード・数式は訳さない)
_KINDS = ("p", "heading", "list", "quote")
# 一度に LLM へ渡す原文の文字数の目安と、前の文脈として添えるブロック数
_BATCH_CHARS = 2500
_CONTEXT_BLOCKS = 2
# 訳語表から一度に渡す語の上限
_GLOSSARY_MAX = 60

_HEADING_RE = re.compile(r"^(#{1,6})\s+")
_SCENE_BREAK_RE = re.compile(r"^\*{3,}\s*$")
# 文の区切り: . ! ? …(閉じ引用符・括弧・強調記号を含む)のあとに空白があり、次が大文字・引用符・数字で始まる
_SENTENCE_END_RE = re.compile(r"[.!?…]+[\"”’')\]*_]*(?=\s+[\"“‘'(\[*_]*[A-Z0-9])")
# 文末とみなさない略語(Mr. Smith など)
_ABBREV = {
    "mr", "mrs", "ms", "dr", "st", "jr", "sr", "vs", "etc", "mt", "prof", "gen", "col",
    "lt", "capt", "sgt", "rev", "e.g", "i.e",
}
# 番号の前の略語(No. 5、p. 12)。直後が数字のときだけ略語とみなす(No. Wrong word は文の区切り)
_ABBREV_NUM = {"no", "p", "pp", "fig", "vol", "ch"}

_BATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "blocks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "pairs": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "from": {"type": "integer"},
                                "to": {"type": "integer"},
                                "ja": {"type": "string"},
                            },
                            "required": ["from", "to", "ja"],
                        },
                    },
                },
                "required": ["id", "pairs"],
            },
        },
        "terms": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"en": {"type": "string"}, "ja": {"type": "string"}},
                "required": ["en", "ja"],
            },
        },
    },
    "required": ["blocks", "terms"],
}


class TranslateError(RuntimeError):
    pass


def split_sentences(text: str) -> list[str]:
    """英文を文に分ける。略語(Mr. など)と頭文字(J. など)の後では分けない。"""
    out: list[str] = []
    start = 0
    for m in _SENTENCE_END_RE.finditer(text):
        word = re.search(r"([A-Za-z.]+)\.$", text[start : m.start() + 1])
        if m.group(0).startswith(".") and word:
            w = word.group(1).lower()
            if w in _ABBREV_NUM:
                if text[m.end() :].lstrip()[:1].isdigit():
                    continue
            elif w in _ABBREV or (len(w) == 1 and w.isalpha()):
                continue
        out.append(text[start : m.end()].strip())
        start = m.end()
    tail = text[start:].strip()
    if tail:
        out.append(tail)
    return [s for s in out if s]


def block_key(md: str) -> str:
    return hashlib.sha1(md.encode("utf-8")).hexdigest()[:16]


def _translatable(block: dict) -> bool:
    return block.get("kind") in _KINDS and not _SCENE_BREAK_RE.match(block.get("md", "").strip())


def _source(block: dict) -> tuple[str, str]:
    """(見出しの記号など訳さない頭の部分, 訳す本文)。"""
    md = block["md"].strip()
    m = _HEADING_RE.match(md)
    if m:
        return m.group(0), md[m.end() :]
    if block.get("kind") == "list":
        lm = re.match(r"^([-*+]\s+|\d+[.)]\s+)", md)
        if lm:
            return lm.group(0), md[lm.end() :]
    return "", md


def _path(book_dir: Path) -> Path:
    return book_dir / TRANSLATION_DIRNAME / TRANSLATION_FILE


def _load(book_dir: Path) -> dict:
    try:
        data = json.loads(_path(book_dir).read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("schema") == SCHEMA:
            data.setdefault("blocks", {})
            data.setdefault("glossary", {})
            return data
    except (OSError, ValueError):
        pass
    return {"schema": SCHEMA, "blocks": {}, "glossary": {}}


def _save(book_dir: Path, data: dict) -> None:
    path = _path(book_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(path)


def _book_dir(root: Path, work_id: str) -> tuple[Path, dict]:
    book_dir, _, _ = transcribe._book(root, work_id)
    return book_dir, library.read_book(book_dir) or {}


def _pairs_text(entry: dict) -> str:
    return " ".join(p["ja"] for p in entry.get("pairs", []))


def _normalize_pairs(raw: list, count: int) -> list[dict] | None:
    """LLM の組を検証する。原文の文を順に漏れなく覆っていなければ None(訳し直しの対象に残す)。"""
    pairs = []
    expect = 0
    for p in raw or []:
        try:
            a, b, ja = int(p["from"]), int(p["to"]), str(p["ja"]).strip()
        except (KeyError, TypeError, ValueError):
            return None
        if a != expect or b < a or b >= count or not ja:
            return None
        pairs.append({"s": [a, b], "ja": ja})
        expect = b + 1
    return pairs if expect == count else None


def _prompt(title: str, batch: list[dict], context: list[tuple[str, str]], glossary: dict[str, str]) -> str:
    lines = [
        f"英語の本「{title}」の本文を、自然で読みやすい日本語に訳してください。",
        "",
        "守ること:",
        "- 各ブロックの原文は番号付きの文に分けてあります。訳は「from〜to 番の文 ↔ 日本語」の組で返し、",
        "  0 番から最後の文まで順に、漏れなく重なりなく覆ってください。",
        "- 組は原則 1 文ずつ(from = to)にする。読者が原文と 1 文ずつ見比べるためです。まとめてよいのは、",
        "  会話の途中で切れた文など、分けると日本語が不自然になるときだけ(段落全体を 1 組にしない)。",
        "- 原文に忠実に訳し、要約・省略・説明の付け足しをしない。会話は「」で、* で囲んだ強調は *…* のまま残す。",
        "- 固有名詞・作中の用語は、訳語表があればそれに従う。新しく訳した固有名詞・作中の用語は terms に入れる",
        "  (一般的な語は入れない)。",
        "- 見出しは見出しらしく短く訳す。章番号だけの見出し(One、Twenty-Three)は「第一章」「第二十三章」とする。",
    ]
    if glossary:
        lines += ["", "訳語表:"] + [f"- {en} → {ja}" for en, ja in glossary.items()]
    if context:
        lines += ["", "直前の本文(参考。訳さない):"]
        for en, ja in context:
            lines += [f"EN: {en}", f"JA: {ja}"]
    lines += ["", "訳すブロック:"]
    for b in batch:
        lines.append(f"[ブロック {b['id']}]")
        lines += [f"{i}: {s}" for i, s in enumerate(b["sents"])]
    return "\n".join(lines)


def _relevant_glossary(glossary: dict[str, str], text: str) -> dict[str, str]:
    hit = {en: ja for en, ja in glossary.items() if en and en in text}
    return dict(list(hit.items())[:_GLOSSARY_MAX])


def run(
    root: Path,
    work_id: str,
    base_url: str,
    *,
    redo: bool = False,
    cancel_check: Callable[[], bool] | None = None,
) -> int:
    """まだ訳していないブロックを先頭から訳し、訳したブロック数を返す。redo なら全部訳し直す(訳語表は残す)。"""
    book_dir, book = _book_dir(root, work_id)
    if library.book_language(book) != "en":
        raise TranslateError("日本語訳を作れるのは英語の本だけです")
    title = book.get("title") or ""
    blocks = content.load(root, work_id)["blocks"]
    data = _load(book_dir)
    if redo:
        data["blocks"] = {}
    todo = [
        i for i, b in enumerate(blocks) if _translatable(b) and block_key(b["md"]) not in data["blocks"]
    ]
    total = len(todo)
    done = 0
    set_progress(work_id, 0, total, "translate")
    try:
        k = 0
        while k < len(todo):
            if cancel_check and cancel_check():
                raise Cancelled()
            # 続いたブロックを、文字数の目安までまとめる
            batch: list[dict] = []
            chars = 0
            while k < len(todo) and (not batch or chars + len(blocks[todo[k]]["md"]) <= _BATCH_CHARS):
                i = todo[k]
                if batch and i != batch[-1]["index"] + 1:
                    break  # 間に訳済み・訳さないブロックがあれば、そこで切る
                head, text = _source(blocks[i])
                batch.append({"id": len(batch), "index": i, "head": head, "sents": split_sentences(text)})
                chars += len(text)
                k += 1
            context = []
            for j in range(batch[0]["index"] - 1, -1, -1):
                if len(context) >= _CONTEXT_BLOCKS:
                    break
                entry = data["blocks"].get(block_key(blocks[j]["md"]))
                if entry:
                    context.insert(0, (_source(blocks[j])[1], _pairs_text(entry)))
            src_text = " ".join(" ".join(b["sents"]) for b in batch)
            prompt = _prompt(title, batch, context, _relevant_glossary(data["glossary"], src_text))
            out = llm.chat(
                base_url,
                [{"role": "user", "content": prompt}],
                temperature=0.2,
                think=False,
                json_schema=_BATCH_SCHEMA,
            )
            result = llm.parse_json(out)
            by_id = {r.get("id"): r for r in result.get("blocks") or [] if isinstance(r, dict)}
            now = datetime.now(timezone.utc).isoformat()
            for b in batch:
                pairs = _normalize_pairs((by_id.get(b["id"]) or {}).get("pairs"), len(b["sents"]))
                if pairs is None:
                    continue  # 組が崩れた(文の取りこぼし)ブロックは訳さずに残す。次の実行で訳し直す
                data["blocks"][block_key(blocks[b["index"]]["md"])] = {
                    "head": b["head"],
                    "src": b["sents"],
                    "pairs": pairs,
                    "at": now,
                }
                done += 1
            for t in result.get("terms") or []:
                if isinstance(t, dict) and t.get("en") and t.get("ja"):
                    data["glossary"].setdefault(str(t["en"]).strip(), str(t["ja"]).strip())
            _save(book_dir, data)
            set_progress(work_id, min(k, total), total, "translate")
    finally:
        clear_progress(work_id)
    return done


def get_translation(root: Path, work_id: str) -> dict:
    """content.json のブロックの並びに合わせた訳。

    {signature, total, done, blocks}。blocks[i] は訳さないブロックと未訳のブロックでは None、
    訳したブロックでは {head, pairs: [{en, ja}]}(en は組が覆う原文の文をつないだもの)。
    """
    book_dir, _ = _book_dir(root, work_id)
    data = content.load(root, work_id)
    saved = _load(book_dir)["blocks"]
    out: list[dict | None] = []
    total = done = 0
    for b in data["blocks"]:
        if not _translatable(b):
            out.append(None)
            continue
        total += 1
        entry = saved.get(block_key(b["md"]))
        if not entry:
            out.append(None)
            continue
        done += 1
        src = entry.get("src") or []
        out.append(
            {
                "head": entry.get("head", ""),
                "pairs": [
                    {"en": " ".join(src[p["s"][0] : p["s"][1] + 1]), "ja": p["ja"]}
                    for p in entry.get("pairs", [])
                ],
            }
        )
    return {"signature": data["signature"], "total": total, "done": done, "blocks": out}
