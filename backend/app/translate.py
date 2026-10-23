"""英語の本の日本語訳(対訳表示用)。

アプリ用の本文(content.json)のブロック(段落・見出し・箇条など)を、ローカル LLM で日本語に訳す。
原文は文に分け、訳は「原文の何文目から何文目まで ↔ 訳文」の組で持つ(英語 2 文を日本語 1 文にまとめる、
などの言い換えを許すため)。表示はこの組を文 / 段落 / 節の単位にまとめ直すので、単位を変えても訳し直さない。

訳は「訳の種類」(自然な訳・直訳・自分で作った種類。訳し方の指示)ごとに、本フォルダの
translation/<種類の id>.json に保存する(生成物。消せば訳し直す)。ブロックは本文の指紋(md の SHA-1)で
引くので、content.json を作り直しても本文が同じブロックの訳は残る。本文を直したブロックだけ訳し直しになる。
固有名詞などの訳語は translation/glossary.json に溜め(種類をまたいで共有)、次のまとまりに渡して訳をそろえる。
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import content, library, llm, transcribe
from .config import data_dir
from .progress import Cancelled, clear_progress, set_progress

TRANSLATION_DIRNAME = "translation"
GLOSSARY_FILE = "glossary.json"
# 種類ができる前の訳(自然な訳 + 訳語表)。読むときに natural.json と glossary.json へ移す
LEGACY_FILE = "ja.json"
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


# ---- 訳の種類(訳し方の指示) ----
# 組み込みの種類はここで持ち、自分で作った種類は管理ルートの .book-viewer/translation_styles.json に置く
# (本の訳 translation/<種類の id>.json が id で参照するので、ライブラリと一緒に持ち運べるように)。
# 種類で変えられるのは「訳し方」だけ。文の組・JSON の形・訳語表などの決まりは _prompt で固定する。
STYLES_FILE = "translation_styles.json"
DEFAULT_STYLE = "natural"
_STYLE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
_STYLE_TEXT_MAX = 4000

BUILTIN_STYLES = [
    {
        "id": "natural",
        "name": "自然な訳",
        "builtin": True,
        "instructions": (
            "- 自然で読みやすい日本語に訳す。\n"
            "- 原文に忠実に訳し、要約・省略・説明の付け足しをしない。\n"
            "- 会話は「」で囲む。"
        ),
    },
    {
        "id": "literal",
        "name": "直訳",
        "builtin": True,
        "instructions": (
            "- 英語の学習者が原文と見比べやすいよう、英文の構造と語順になるべく沿って訳す。日本語として多少\n"
            "  ぎこちなくてもよいので、意味を取り違えない訳を優先する。\n"
            "- 語を省いたり、言い換えたりしない。慣用句は文字どおりの訳のあとに(= 意味)を添える。\n"
            "- 会話は「」で囲む。"
        ),
    },
]


def _styles_path(root: Path) -> Path:
    return data_dir(root) / STYLES_FILE


def _custom_styles(root: Path) -> list[dict]:
    try:
        data = json.loads(_styles_path(root).read_text(encoding="utf-8"))
        return [s for s in data.get("styles", []) if isinstance(s, dict) and s.get("id") and s.get("name")]
    except (OSError, ValueError, AttributeError):
        return []


def list_styles(root: Path) -> list[dict]:
    """組み込みの種類と自分で作った種類(組み込みが先)。"""
    return [dict(s) for s in BUILTIN_STYLES] + [{**s, "builtin": False} for s in _custom_styles(root)]


def save_styles(root: Path, styles: list[dict]) -> list[dict]:
    """自分で作った種類の一覧を保存する(組み込みの種類は含めない)。id の無いものには新しい id を付ける。"""
    builtin_ids = {s["id"] for s in BUILTIN_STYLES}
    out: list[dict] = []
    seen: set[str] = set()
    now = datetime.now(timezone.utc).isoformat()
    for s in styles:
        name = str(s.get("name") or "").strip()
        instructions = str(s.get("instructions") or "").strip()
        if not name or not instructions:
            raise TranslateError("訳の種類には名前と訳し方の指示が要ります")
        if len(name) > 40 or len(instructions) > _STYLE_TEXT_MAX:
            raise TranslateError("訳の種類の名前か指示が長すぎます")
        sid = str(s.get("id") or "") or f"c-{uuid.uuid4().hex[:8]}"
        if not _STYLE_ID_RE.match(sid) or sid in builtin_ids or sid in seen:
            raise TranslateError(f"訳の種類の id が正しくありません: {sid}")
        seen.add(sid)
        out.append({"id": sid, "name": name, "instructions": instructions, "updated_at": s.get("updated_at") or now})
    # 指示が変わった種類だけ更新日時を新しくする
    before = {s["id"]: s for s in _custom_styles(root)}
    for s in out:
        old = before.get(s["id"])
        if not old or old.get("instructions") != s["instructions"] or old.get("name") != s["name"]:
            s["updated_at"] = now
    path = _styles_path(root)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"styles": out}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(path)
    return list_styles(root)


def get_style(root: Path, style_id: str) -> dict:
    for s in list_styles(root):
        if s["id"] == style_id:
            return s
    raise TranslateError("訳の種類が見つかりません(消された可能性があります)")


def style_hash(style: dict) -> str:
    """訳し方の指示の指紋。ブロックごとに残し、指示を書き直したあとに古い指示の訳を見分ける。"""
    return hashlib.sha1(style["instructions"].encode("utf-8")).hexdigest()[:12]


# ---- 翻訳中の途中経過(ストリーミング) ----
# LLM の出力を受け取りながら、書きかけの JSON から訳文の組を取り出してここに置く。画面は翻訳中に
# get_live() をこまめに読み、保存前の訳を少しずつ表示する。まとまりを保存したら消す。
_live_lock = threading.Lock()
_live: dict[str, dict] = {}  # work_id -> {"signature", "style", "blocks": {ブロックの添字: 訳したブロック}}
# 途中経過を取り出す間隔(秒)
_LIVE_INTERVAL = 0.4

_LIVE_ID_RE = re.compile(r'"id"\s*:\s*(\d+)')
# スキーマのプロパティ順(from, to, ja)で出力される。ja は書きかけ(閉じ引用符が無い)でもよい
_LIVE_PAIR_RE = re.compile(r'"from"\s*:\s*(\d+)\s*,\s*"to"\s*:\s*(\d+)\s*,\s*"ja"\s*:\s*"((?:[^"\\]|\\.)*)')


def _decode_partial(raw: str) -> str:
    """JSON 文字列の中身(書きかけ)を戻す。末尾の書きかけのエスケープ(バックスラッシュだけ、桁の足りない u)は落とす。"""
    raw = re.sub(r"\\(u[0-9a-fA-F]{0,3})?$", "", raw)
    try:
        return json.loads(f'"{raw}"')
    except ValueError:
        return raw


def _partial_pairs(text: str) -> dict[int, list[dict]]:
    """書きかけの出力から、ブロックの id ごとの組 [{from, to, ja}] を取り出す。"""
    out: dict[int, list[dict]] = {}
    ids = list(_LIVE_ID_RE.finditer(text))
    for n, m in enumerate(ids):
        end = ids[n + 1].start() if n + 1 < len(ids) else len(text)
        out[int(m.group(1))] = [
            {"from": int(p.group(1)), "to": int(p.group(2)), "ja": _decode_partial(p.group(3))}
            for p in _LIVE_PAIR_RE.finditer(text, m.end(), end)
        ]
    return out


def _set_live(
    work_id: str, signature: str, style_id: str, batch: list[dict], text: str, model: str | None
) -> None:
    blocks: dict[int, dict] = {}
    for bid, pairs in _partial_pairs(text).items():
        if not (0 <= bid < len(batch)) or not pairs:
            continue
        b = batch[bid]
        n = len(b["sents"])
        shown = []
        for pr in pairs:
            a, z = min(pr["from"], n - 1), min(max(pr["to"], pr["from"]), n - 1)
            if a < 0:
                continue
            shown.append({"en": " ".join(b["sents"][a : z + 1]), "ja": pr["ja"]})
        if shown:
            blocks[b["index"]] = {"head": b["head"], "model": model or "", "pairs": shown, "live": True}
    with _live_lock:
        _live[work_id] = {"signature": signature, "style": style_id, "blocks": blocks}


def _clear_live(work_id: str) -> None:
    with _live_lock:
        _live.pop(work_id, None)


def get_live(work_id: str) -> dict:
    """翻訳中のまとまりの、保存前の訳(画面の途中表示用)。翻訳していなければ blocks は空。"""
    with _live_lock:
        cur = _live.get(work_id)
        if not cur:
            return {"signature": None, "style": None, "blocks": {}}
        return {
            "signature": cur["signature"],
            "style": cur["style"],
            "blocks": {str(k): v for k, v in cur["blocks"].items()},
        }


def _translate_batch(
    base_url: str,
    prompt: str,
    work_id: str,
    signature: str,
    style_id: str,
    batch: list[dict],
    model: str | None,
    cancel_check: Callable[[], bool] | None,
) -> str:
    """まとまりを訳し、LLM の出力(JSON の文字列)を返す。受け取りながら途中経過を _live に置く。"""
    messages = [{"role": "user", "content": prompt}]
    text = ""
    last = 0.0
    try:
        for delta in llm.chat_stream(base_url, messages, temperature=0.2, think=False, json_schema=_BATCH_SCHEMA):
            if cancel_check and cancel_check():
                raise Cancelled()
            if delta["type"] != "content":
                continue
            text += delta["text"]
            if time.monotonic() - last >= _LIVE_INTERVAL:
                last = time.monotonic()
                _set_live(work_id, signature, style_id, batch, text, model)
    except llm.LlmHttpError as e:
        # json_schema のストリーミングを受け付けないサーバは、まとめて受け取る(途中経過は出ない)
        if e.status != 400:
            raise
        return llm.chat(base_url, messages, temperature=0.2, think=False, json_schema=_BATCH_SCHEMA)
    return llm.strip_think(text)


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


def _path(book_dir: Path, style_id: str) -> Path:
    return book_dir / TRANSLATION_DIRNAME / f"{style_id}.json"


def _read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(path)


def _migrate(book_dir: Path) -> None:
    """種類ができる前の translation/ja.json を、自然な訳(natural.json)と訳語表(glossary.json)に分ける。"""
    legacy = book_dir / TRANSLATION_DIRNAME / LEGACY_FILE
    if not legacy.is_file():
        return
    data = _read_json(legacy) or {}
    if not _path(book_dir, DEFAULT_STYLE).exists():
        _write_json(_path(book_dir, DEFAULT_STYLE), {"schema": SCHEMA, "blocks": data.get("blocks") or {}})
    glossary = _load_glossary(book_dir)
    for en, ja in (data.get("glossary") or {}).items():
        glossary.setdefault(en, ja)
    _write_json(book_dir / TRANSLATION_DIRNAME / GLOSSARY_FILE, {"schema": SCHEMA, "glossary": glossary})
    legacy.unlink()


def _load(book_dir: Path, style_id: str) -> dict:
    _migrate(book_dir)
    data = _read_json(_path(book_dir, style_id))
    if data and data.get("schema") == SCHEMA:
        data.setdefault("blocks", {})
        return data
    return {"schema": SCHEMA, "blocks": {}}


def _save(book_dir: Path, style_id: str, data: dict) -> None:
    _write_json(_path(book_dir, style_id), data)


def _load_glossary(book_dir: Path) -> dict[str, str]:
    """固有名詞などの訳語表(種類をまたいで共有する)。"""
    data = _read_json(book_dir / TRANSLATION_DIRNAME / GLOSSARY_FILE) or {}
    glossary = data.get("glossary")
    return dict(glossary) if isinstance(glossary, dict) else {}


def _save_glossary(book_dir: Path, glossary: dict[str, str]) -> None:
    _write_json(book_dir / TRANSLATION_DIRNAME / GLOSSARY_FILE, {"schema": SCHEMA, "glossary": glossary})


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


def _prompt(
    title: str,
    instructions: str,
    batch: list[dict],
    context: list[tuple[str, str]],
    glossary: dict[str, str],
) -> str:
    """訳の指示。instructions(訳の種類の訳し方)のあとに、アプリが決める守ることを置く(こちらを優先)。"""
    lines = [
        f"英語の本「{title}」の本文を日本語に訳してください。",
        "",
        "訳し方:",
        instructions.strip(),
        "",
        "守ること(訳し方と食い違うときは、こちらを優先する):",
        "- 各ブロックの原文は番号付きの文に分けてあります。訳は「from〜to 番の文 ↔ 日本語」の組で返し、",
        "  0 番から最後の文まで順に、漏れなく重なりなく覆ってください(どの文の訳も省かない)。",
        "- 組は原則 1 文ずつ(from = to)にする。読者が原文と 1 文ずつ見比べるためです。まとめてよいのは、",
        "  会話の途中で切れた文など、分けると日本語が不自然になるときだけ(段落全体を 1 組にしない)。",
        "- * で囲んだ強調は *…* のまま残す。",
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
    style_id: str = DEFAULT_STYLE,
    redo: bool = False,
    stale: bool = False,
    indices: list[int] | None = None,
    model: str | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> int:
    """訳の種類 style_id で、まだ訳していないブロックを先頭から訳し、訳したブロック数を返す。

    redo なら訳したブロックも全部訳し直す。stale なら、今と違う指示(訳し方を書き直す前)で訳したブロックだけ
    訳し直す。indices を渡すと、そのブロック(content.json の添字)だけを訳し直す(今の画面の段落など)。
    どれも訳語表は残し、新しい訳が取れなかったブロックは前の訳のままにする。
    model は訳したモデルの名前(ブロックごとに残し、モデルを変えて訳し直したときに見分ける)。
    """
    book_dir, book = _book_dir(root, work_id)
    if library.book_language(book) != "en":
        raise TranslateError("日本語訳を作れるのは英語の本だけです")
    title = book.get("title") or ""
    style = get_style(root, style_id)
    shash = style_hash(style)
    loaded = content.load(root, work_id)
    blocks = loaded["blocks"]
    data = _load(book_dir, style_id)
    glossary = _load_glossary(book_dir)
    if indices is not None:
        wanted = set(indices)
        todo = [i for i, b in enumerate(blocks) if i in wanted and _translatable(b)]
    elif stale:
        todo = [
            i
            for i, b in enumerate(blocks)
            if _translatable(b) and _is_stale(data["blocks"].get(block_key(b["md"])), shash)
        ]
    elif redo:
        todo = [i for i, b in enumerate(blocks) if _translatable(b)]
    else:
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
            prompt = _prompt(title, style["instructions"], batch, context, _relevant_glossary(glossary, src_text))
            out = _translate_batch(
                base_url, prompt, work_id, loaded["signature"], style_id, batch, model, cancel_check
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
                    "model": model,
                    "style_hash": shash,
                    "at": now,
                }
                done += 1
            for t in result.get("terms") or []:
                if isinstance(t, dict) and t.get("en") and t.get("ja"):
                    glossary.setdefault(str(t["en"]).strip(), str(t["ja"]).strip())
            _save(book_dir, style_id, data)
            _save_glossary(book_dir, glossary)
            _clear_live(work_id)
            set_progress(work_id, min(k, total), total, "translate")
    finally:
        _clear_live(work_id)
        clear_progress(work_id)
    return done


def _is_stale(entry: dict | None, shash: str) -> bool:
    """今と違う指示で訳したブロックか。指示の記録が無い(種類ができる前の)訳は古いとみなさない。"""
    return bool(entry) and bool(entry.get("style_hash")) and entry["style_hash"] != shash


def get_translation(root: Path, work_id: str, style_id: str = DEFAULT_STYLE) -> dict:
    """content.json のブロックの並びに合わせた、訳の種類 style_id の訳。

    {signature, style, total, done, stale, models, styles, blocks}。blocks[i] は訳さないブロックと未訳のブロックでは
    None、訳したブロックでは {head, model, pairs: [{en, ja}]}(en は組が覆う原文の文をつないだもの)。
    stale は今と違う指示で訳したブロックの数。models は訳したモデルごとのブロック数(多い順)。
    styles はこの本に訳がある種類ごとの訳したブロック数({種類の id: 数})。
    """
    book_dir, _ = _book_dir(root, work_id)
    shash = style_hash(get_style(root, style_id))
    data = content.load(root, work_id)
    saved = _load(book_dir, style_id)["blocks"]
    out: list[dict | None] = []
    total = done = stale = 0
    models: dict[str, int] = {}
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
        if _is_stale(entry, shash):
            stale += 1
        model = entry.get("model") or ""
        models[model] = models.get(model, 0) + 1
        src = entry.get("src") or []
        out.append(
            {
                "head": entry.get("head", ""),
                "model": model,
                "pairs": [
                    {"en": " ".join(src[p["s"][0] : p["s"][1] + 1]), "ja": p["ja"]}
                    for p in entry.get("pairs", [])
                ],
            }
        )
    ranked = sorted(models.items(), key=lambda kv: -kv[1])
    styles = {}
    for path in sorted((book_dir / TRANSLATION_DIRNAME).glob("*.json")):
        if path.name != GLOSSARY_FILE:
            styles[path.stem] = len((_read_json(path) or {}).get("blocks") or {})
    return {
        "signature": data["signature"],
        "style": style_id,
        "total": total,
        "done": done,
        "stale": stale,
        "models": [{"model": m, "blocks": n} for m, n in ranked],
        "styles": styles,
        "blocks": out,
    }


# ---- 本文検索の索引に入れる訳 ------------------------------------------------------

_EMPHASIS_RE = re.compile(r"\*{1,3}([^*]+)\*{1,3}")


def _style_order(book_dir: Path) -> list[str]:
    """訳を探す種類の順: 自然な訳、その次は新しく書いた種類から。"""
    paths = [p for p in (book_dir / TRANSLATION_DIRNAME).glob("*.json") if p.name != GLOSSARY_FILE]
    paths.sort(key=lambda p: (p.stem != DEFAULT_STYLE, -p.stat().st_mtime))
    return [p.stem for p in paths]


def block_pairs(root: Path, work_id: str, blocks: list[dict]) -> dict[int, list[tuple[str, str]]]:
    """訳してあるブロックの訳の組 {ブロックの添字: [(原文, 訳文), …]}(本文検索の索引・検索結果に使う)。

    blocks は content.json のブロックの並び。訳の種類は自然な訳を優先し、無ければほかの種類の訳を使う
    (検索は読む画面で選んだ種類を知らないため)。強調の *…* は外す。
    """
    try:
        book_dir, _ = _book_dir(root, work_id)
        if not (book_dir / TRANSLATION_DIRNAME).is_dir():
            return {}
        styles = [_load(book_dir, s)["blocks"] for s in _style_order(book_dir)]
    except Exception:  # noqa: BLE001 - 本フォルダでない・読めないときは訳を使わない
        return {}
    out: dict[int, list[tuple[str, str]]] = {}
    for i, b in enumerate(blocks):
        if not _translatable(b):
            continue
        key = block_key(b["md"])
        entry = next((st[key] for st in styles if key in st), None)
        if not entry or not entry.get("pairs"):
            continue
        src = entry.get("src") or []
        out[i] = [
            (
                _EMPHASIS_RE.sub(r"\1", " ".join(src[p["s"][0] : p["s"][1] + 1])),
                _EMPHASIS_RE.sub(r"\1", p["ja"]).strip(),
            )
            for p in entry["pairs"]
        ]
    return out
