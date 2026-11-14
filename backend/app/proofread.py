"""文字起こしの誤字の自動補正(日本語の本)。

OCR は見た目の似た字を取り違える(ブ↔プ・ッ↔ツ・ー↔一・カ↔力 など)。アプリ用の本文(content.json)の
段落をローカル LLM に読ませ、この種の取り違えだけを文脈から見つけて直す。

- 直せるのは「似た字の組」(_GROUPS)の 2 字の、1 字ずつの入れ替えだけ。LLM の答えのうち、組に無い入れ替え・
  字数の変わる書き換えはプログラム側で捨てるので、文章が言い換えられることはない。字数が変わらないので、
  content.json のページの区切りの位置(cont)もずれない。
- 候補を人に確認させず、そのまま直す。直した語はテキスト表示で下線を引き、クリックで元に戻せる
  (戻した補正は off として残し、補正し直しても当て直さない)。
- 原本のページの文字起こし(pages/0001.md。正本)には手を入れない。補正は本フォルダの corrections.json に
  ブロック(補正前の Markdown の SHA-1)ごとに持ち、content.json を組むときに当てる(content.load)。
  文字起こしのやり直し・手直しで本文が変わったブロックは、補正の記録が外れ、次の補正で読み直す。
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import library, llm, transcribe
from .progress import Cancelled, clear_progress, set_progress

CORRECTIONS_FILE = "corrections.json"
SCHEMA = 1

# 補正するブロックの種類(図・表・コード・数式は見ない)
_KINDS = ("p", "heading", "list", "quote")
# 一度に LLM へ渡す本文の文字数の目安
_BATCH_CHARS = 3000
# LLM が挙げる語(誤りの前後を含む)の字数の上限
_WORD_MAX = 16

# 見た目の似た字の組。同じ組に入る 2 字の入れ替えだけを認める(組どうしはつなげない。ソ↔ン と ン↔シ が
# あっても ソ↔シ は認めない)。実際の本で OCR が取り違えた字を見て足していく。
_GROUPS = [
    # 濁点・半濁点
    "カガ", "キギ", "クグ", "ケゲ", "コゴ", "サザ", "シジ", "スズ", "セゼ", "ソゾ",
    "タダ", "チヂ", "ツヅ", "テデ", "トド", "ハバパ", "ヒビピ", "フブプ", "ヘベペ", "ホボポ", "ウヴ",
    "かが", "きぎ", "くぐ", "けげ", "こご", "さざ", "しじ", "すず", "せぜ", "そぞ",
    "ただ", "ちぢ", "つづ", "てで", "とど", "はばぱ", "ひびぴ", "ふぶぷ", "へべぺ", "ほぼぽ",
    # 小さい字
    "アァ", "イィ", "ウゥ", "エェ", "オォ", "ツッ", "ヤャ", "ユュ", "ヨョ", "ワヮ", "カヵ", "ケヶ",
    "あぁ", "いぃ", "うぅ", "えぇ", "おぉ", "つっ", "やゃ", "ゆゅ", "よょ", "わゎ",
    # 形の似た字(かな)
    "カ力", "ロ口", "ニ二", "エ工", "タ夕", "ト卜", "ハ八", "へヘ", "べベ", "ぺペ", "りリ", "チ千", "キ千", "オ才",
    "シツ", "ソン", "ンシ", "ツウ", "グゲ", "ダグ", "ゾグ", "ュェ", "テチ", "ロコ", "とこ", "二工",
    # 形の似た字(記号・英字・漢字)
    "ー一ｰ", "ーI", "人入", "未末", "士土", "己已", "合台", "瓦互",
]


def _build_pairs() -> set[tuple[str, str]]:
    return {(a, b) for g in _GROUPS for a in g for b in g if a != b}


_PAIRS = _build_pairs()


class ProofreadError(RuntimeError):
    pass


def allowed(wrong: str, right: str) -> bool:
    """wrong → right が「似た字の組」の中での入れ替えだけでできているか(1 字以上変わる)。"""
    if not wrong or len(wrong) != len(right) or wrong == right or len(wrong) > _WORD_MAX:
        return False
    for a, b in zip(wrong, right):
        if a == b:
            continue
        if (a, b) not in _PAIRS:
            return False
    return True


def block_key(md: str) -> str:
    """補正前のブロックの Markdown の指紋。"""
    return hashlib.sha1(md.encode("utf-8")).hexdigest()


def corrections_path(book_dir: Path) -> Path:
    return book_dir / CORRECTIONS_FILE


def _load(book_dir: Path) -> dict:
    try:
        data = json.loads(corrections_path(book_dir).read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("blocks"), dict):
            return data
    except (OSError, ValueError):
        pass
    return {"schema": SCHEMA, "blocks": {}}


def _save(book_dir: Path, data: dict) -> None:
    path = corrections_path(book_dir)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(path)


# ---- content.json を組むときに当てる -------------------------------------------------


def apply(book_dir: Path, blocks: list[dict]) -> None:
    """ブロックの並びに補正を当てる(content.load から呼ぶ。blocks をその場で書き換える)。

    補正したブロックには fixes([{pos, from, to}]。pos は補正後の md の中の位置)と、補正前の指紋 pk を付ける。
    記録した位置の文字列が今の本文と合わない補正は当てない。
    """
    if not corrections_path(book_dir).exists():
        return
    saved = _load(book_dir)["blocks"]
    for b in blocks:
        entry = saved.get(block_key(b["md"]))
        if not entry or not entry.get("fixes"):
            continue
        md = b["md"]
        shown = []
        for f in entry["fixes"]:
            pos, src, dst = f.get("pos"), f.get("from") or "", f.get("to") or ""
            if not isinstance(pos, int) or md[pos : pos + len(src)] != src or len(src) != len(dst):
                continue
            if f.get("off"):
                continue
            md = md[:pos] + dst + md[pos + len(src) :]
            shown.append({"pos": pos, "from": src, "to": dst})
        b["pk"] = block_key(b["md"])
        if shown:
            b["md"] = md
            b["fixes"] = shown


def raw_md(block: dict) -> str:
    """補正を当てる前のブロックの Markdown。"""
    md = block["md"]
    for f in block.get("fixes") or []:
        md = md[: f["pos"]] + f["from"] + md[f["pos"] + len(f["from"]) :]
    return md


def set_off(root: Path, work_id: str, index: int, pos: int, off: bool) -> None:
    """ブロック index(content.json の添字)の pos の補正を戻す(off)・当て直す。"""
    from . import content

    book_dir, _ = _book_dir(root, work_id)
    blocks = content.load(root, work_id)["blocks"]
    if not 0 <= index < len(blocks):
        raise ProofreadError("ブロックが見つかりません")
    key = blocks[index].get("pk") or block_key(raw_md(blocks[index]))
    data = _load(book_dir)
    entry = data["blocks"].get(key)
    hit = next((f for f in (entry or {}).get("fixes") or [] if f.get("pos") == pos), None)
    if hit is None:
        raise ProofreadError("補正が見つかりません")
    if off:
        hit["off"] = True
    else:
        hit.pop("off", None)
    _save(book_dir, data)


# ---- 補正のジョブ ---------------------------------------------------------------

_SCHEMA = {
    "type": "object",
    "properties": {
        "fixes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "wrong": {"type": "string"},
                    "right": {"type": "string"},
                },
                "required": ["id", "wrong", "right"],
            },
        }
    },
    "required": ["fixes"],
}


def _prompt(title: str, batch: list[dict]) -> str:
    lines = "\n".join(f"[{b['id']}] {b['text']}" for b in batch)
    return (
        "あなたは、OCR(文字認識)で読み取った日本語の本の本文から誤字を見つける校正者です。\n"
        "OCR は見た目の似た字を取り違えることがあります。例:\n"
        "- 濁点と半濁点(ブ↔プ、バ↔パ、ボ↔ポ)、濁点の有無(カ↔ガ、は↔ば)\n"
        "- 小さい字と大きい字(ッ↔ツ、ャ↔ヤ、ョ↔ヨ、っ↔つ)\n"
        "- 形の似た字(ー↔一、カ↔力、ロ↔口、ニ↔二、エ↔工、タ↔夕、ト↔卜、ハ↔八、ヘ↔へ、シ↔ツ、ソ↔ン、"
        "人↔入、未↔末)\n\n"
        "下の段落から、この種の取り違えによる誤りだけを探してください。決まり:\n"
        "- 前後の文脈から誤りだと確信できるものだけを挙げる。迷うもの・どちらでも意味が通るもの・"
        "固有名詞で正しい形が分からないものは挙げない。\n"
        "- 言い換え・表記ゆれ・送り仮名・句読点・文体は直さない。上の種類以外の誤字も挙げない。\n"
        "- wrong には段落に書かれているとおりの、誤りを含む語を入れる(段落の中で見分けられるよう、"
        "前後の字を含めて 2〜10 字)。right にはそれを直したもの(同じ字数)を入れる。\n"
        "- ほとんどの段落には誤りがありません。誤りが無ければ fixes は空の配列にする。\n\n"
        f"書名: {title}\n\n"
        f"本文:\n{lines}\n\n"
        '出力: {"fixes": [{"id": 段落の番号, "wrong": "...", "right": "..."}]}'
    )


def _locate(md: str, wrong: str, right: str, taken: list[tuple[int, int]]) -> list[dict]:
    """md の中の wrong の出現ごとの補正 [{pos, from, to}](ほかの補正と重なる出現は除く)。"""
    out = []
    start = md.find(wrong)
    while start >= 0:
        end = start + len(wrong)
        if all(end <= s or start >= e for s, e in taken):
            out.append({"pos": start, "from": wrong, "to": right})
            taken.append((start, end))
        start = md.find(wrong, end)
    return out


def _proofreadable(block: dict) -> bool:
    return block.get("kind") in _KINDS


def _book_dir(root: Path, work_id: str) -> tuple[Path, dict]:
    book_dir, _, _ = transcribe._book(root, work_id)
    return book_dir, library.read_book(book_dir) or {}


def run(
    root: Path,
    work_id: str,
    base_url: str,
    *,
    redo: bool = False,
    model: str | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> int:
    """まだ補正していないブロックを先頭から LLM に読ませて直し、直した箇所の数を返す。

    redo なら補正したブロックも読み直す(元に戻した補正は、見つかっても当て直さない)。
    """
    from . import content

    book_dir, book = _book_dir(root, work_id)
    if library.book_language(book) != "ja":
        raise ProofreadError("誤字の補正は日本語の本だけです")
    title = book.get("title") or ""
    blocks = content.load(root, work_id)["blocks"]
    data = _load(book_dir)
    saved = data["blocks"]
    todo: list[tuple[str, str]] = []  # (補正前の指紋, 補正前の md)
    seen: set[str] = set()
    for b in blocks:
        if not _proofreadable(b):
            continue
        md = raw_md(b)
        key = block_key(md)
        if key in seen or (key in saved and not redo):
            continue
        seen.add(key)
        todo.append((key, md))
    total = sum(len(md) for _, md in todo)
    done_chars = 0
    fixed = 0
    set_progress(work_id, 0, total, "proofread")
    try:
        k = 0
        while k < len(todo):
            if cancel_check and cancel_check():
                raise Cancelled()
            batch: list[dict] = []
            chars = 0
            while k < len(todo) and (not batch or chars + len(todo[k][1]) <= _BATCH_CHARS):
                key, md = todo[k]
                batch.append({"id": len(batch), "key": key, "md": md, "text": transcribe.strip_ruby(md)})
                chars += len(md)
                k += 1
            out = llm.chat(
                base_url,
                [{"role": "user", "content": _prompt(title, batch)}],
                temperature=0.0,
                think=False,
                json_schema=_SCHEMA,
            )
            found: dict[int, list[tuple[str, str]]] = {}
            for f in llm.parse_json(out).get("fixes") or []:
                if not isinstance(f, dict):
                    continue
                wrong, right = str(f.get("wrong") or ""), str(f.get("right") or "")
                if isinstance(f.get("id"), int) and allowed(wrong, right):
                    found.setdefault(f["id"], []).append((wrong, right))
            now = datetime.now(timezone.utc).isoformat()
            for b in batch:
                prev = saved.get(b["key"]) or {}
                off = {(x["pos"], x["from"], x["to"]) for x in prev.get("fixes") or [] if x.get("off")}
                taken: list[tuple[int, int]] = []
                fixes: list[dict] = []
                for wrong, right in found.get(b["id"], []):
                    fixes.extend(_locate(b["md"], wrong, right, taken))
                for f in fixes:
                    if (f["pos"], f["from"], f["to"]) in off:
                        f["off"] = True
                fixes.sort(key=lambda f: f["pos"])
                saved[b["key"]] = {"fixes": fixes, "model": model, "at": now}
                fixed += sum(1 for f in fixes if not f.get("off"))
                done_chars += len(b["md"])
            _save(book_dir, data)
            set_progress(work_id, done_chars, total, "proofread")
    finally:
        clear_progress(work_id)
    return fixed


def summary(root: Path, work_id: str) -> dict:
    """{total, checked, fixes}: 補正の対象のブロック数・読んだブロック数・当てている補正の数。"""
    from . import content

    book_dir, _ = _book_dir(root, work_id)
    blocks = content.load(root, work_id)["blocks"]
    saved = _load(book_dir)["blocks"]
    total = checked = fixes = 0
    for b in blocks:
        if not _proofreadable(b):
            continue
        total += 1
        if (b.get("pk") or block_key(b["md"])) in saved:
            checked += 1
        fixes += len(b.get("fixes") or [])
    return {"total": total, "checked": checked, "fixes": fixes}
