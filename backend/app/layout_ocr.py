"""YomiToku(日本語の文書 OCR + レイアウト解析)による文字起こし。

1 枚の画像から、読み順に並んだ段落・見出し・図の領域を取り出し、Markdown に変換する。
図は元画像から切り抜いて返し、Markdown では ![キャプション](../figures/…) で参照する。
英語の本(lang="en")は、折り返しの行を空白でつなぎ、行末のハイフンで切れた語をつなぐ。

VLM より字を書き換えにくく(誤字・欠落とも少ない)、1 ページ 1 秒未満で動く
(比較は scripts/ocr-compare/)。モデルは初回使用時に Hugging Face から取得される。
YomiToku のモデルは CC BY-NC-SA 4.0(非商用)。
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass

_analyzer = None
_lock = threading.Lock()

# 図・表の近くにある段落はキャプションとみなす(図の枠をこの px だけ広げて重なりを見る)。
_CAPTION_MARGIN = 48
# これより小さい(縦横とも)領域は図にしない(章番号の飾り文字など)。
_MIN_FIGURE_PX = 80
# 読み取りの確信度(行ごとの rec_score)がこれ未満の本文の行を「要確認」とする。
# サンプルでは 0.6 未満の行に誤読(橄欖→橄横、括弧、ダッシュ→「一」など)が集まっていた。
_LOW_SCORE = 0.6
# キャプションの無い図に、代わりに添える図中の文字の上限(目次ページなどは長いため)。
_INNER_TEXT_MAX = 2000
# 幅が高さのこの倍を超え、中に文字がある「図」は見出しの帯とみなす。
_BANNER_RATIO = 4
# 段落がここで終わっていれば、次の段落とはつながない。
SENTENCE_END = ("。", "」", "』", ")", "）", "！", "？", "!", "?")
_CAPTION_RE = re.compile(r"^\s*(図|表|写真|グラフ)\s*[0-9０-９]")
# 英語の本の文の終わりとキャプション。
SENTENCE_END_EN = (".", "!", "?", '"', "”", "’", ")")
_CAPTION_RE_EN = re.compile(r"^\s*(Figure|Fig\.|Table|Plate|Photo|Chart|Map)\s*[0-9IVX]", re.IGNORECASE)
# 英語の本の場面転換の飾り(* * * や ⁂。YomiToku は「米」と読むことがある)。
_SCENE_BREAK_RE = re.compile(r"^[\s*＊⁂※米✳❋·•]+$")
_BULLET_RE = re.compile(r"^(?:[·・•]\s*|-\s+)")
# 英語の本の箇条の行頭(1. / 2) / · など)。
_LIST_ITEM_RE = re.compile(r"^(?:\d{1,2}[.)]\s|[·・•]\s?)")
# 飾り頭文字の候補(引用符が付くことがある)。数字は字形の似た大文字の読み違い。
_DROP_CAP_RE = re.compile(r"^([\"“‘']?)([A-Z0-9])$")
_DROP_CAP_DIGITS = {"0": "O", "5": "S", "8": "B"}
# 英語の本の飾り頭文字(章の最初の 1 字を大きくしたもの)。本文の字のこの倍より高い 1 字の段落。
_DROP_CAP_RATIO = 1.8
# ルビの候補(かなだけ)と、ルビの親文字にする字(漢字)。
_KANA_RE = re.compile(r"^[ぁ-ゖァ-ヺー]+$")
_KANJI_RE = re.compile(r"[\u3400-\u9fff\uf900-\ufaff々〆ヶ]")
_RUBY_TAG_RE = re.compile(r"<rt>.*?</rt>|</?ruby>")


@dataclass
class Figure:
    """切り抜いた図。name は Markdown で参照するファイル名(拡張子なし部分は呼び出し側で決める)。"""

    png: bytes
    caption: str


def _get_analyzer():
    global _analyzer
    with _lock:
        if _analyzer is None:
            try:
                import torch
                from yomitoku import DocumentAnalyzer
            except ImportError as e:
                raise RuntimeError(
                    "YomiToku が入っていません(backend/requirements.txt を再インストールしてください)"
                ) from e
            device = "cuda" if torch.cuda.is_available() else "cpu"
            # 書名バー・ページ表示(ヘッダー/フッター)は本文に入れない。段落の中身からはルビを除く
            # (ルビは words の座標から親文字に付け直す。_split_paragraphs)。
            _analyzer = DocumentAnalyzer(device=device, ignore_meta=True, ignore_ruby=True)
        return _analyzer


def _overlaps(a: list[int], b: list[int], margin: int) -> bool:
    return not (
        a[2] < b[0] - margin or a[0] > b[2] + margin or a[3] < b[1] - margin or a[1] > b[3] + margin
    )


def _join(a: str, b: str, lang: str) -> str:
    """折り返しで分かれた 2 つの並びをつなぐ。日本語はそのまま続ける。

    英語は空白をはさむ。行末のハイフンで切れた語(some- / thing)はハイフンを外してつなぎ、
    ダッシュの前後には空白を入れない。本来のハイフン(fat- / bellied)も外れてしまうが、
    画像だけでは見分けられない。
    """
    if lang != "en" or not a or not b:
        return a + b
    if re.search(r"[a-z]-$", a) and b[:1].islower():
        return a[:-1] + b
    if a.endswith(("—", "-")) or b.startswith("—"):
        # 大文字で続くハイフン(Pilot-in- / Training)は本来のハイフンなので残す
        return a + b
    return f"{a} {b}"


def _text(p: dict, lang: str = "ja") -> str:
    # 紙面の折り返し改行は取り除く(日本語の本なので空白は足さない。英語は _join でつなぐ)。
    if lang != "en":
        return re.sub(r"\s*\n\s*", "", p["contents"]).strip()
    text = ""
    for line in p["contents"].split("\n"):
        # YomiToku はダッシュ(—)を水平線(―)で返す
        text = _join(text, line.strip().replace("―", "—"), lang)
    return text.strip()


def _center(w: dict) -> tuple[float, float]:
    pts = w["points"]
    return sum(pt[0] for pt in pts) / 4, sum(pt[1] for pt in pts) / 4


def _median(values: list[float]) -> float:
    values = sorted(values)
    return values[len(values) // 2] if values else 0.0


def _word_size(w: dict) -> float:
    """行(word)の字の大きさ。縦書きは幅、横書きは高さ。"""
    xs = [pt[0] for pt in w["points"]]
    ys = [pt[1] for pt in w["points"]]
    return (max(xs) - min(xs)) if w.get("direction") == "vertical" else (max(ys) - min(ys))


def _is_ruby_only(p: dict, words: list[dict], page_char: float) -> bool:
    """ルビだけでできた段落か(本文より明らかに小さい字の、短い段落)。

    ignore_ruby でも、本文から離れたルビが単独の段落として残ることがある。
    """
    if page_char <= 0 or len(_text(p)) > 20:
        return False
    x1, y1, x2, y2 = p["box"]
    sizes = [
        _word_size(w)
        for w in words
        if x1 <= _center(w)[0] <= x2 and y1 <= _center(w)[1] <= y2
    ]
    return bool(sizes) and _median(sizes) < page_char * 0.7


def _drop_cap_text(cap: str, following: str) -> str:
    """飾り頭文字を本文の字に直す。数字に読まれた字は形の似た大文字にする。

    1 は I か J。英語で I の直後に母音が来る語はまれなので、続きが母音なら J(JONAS)、そうでなければ I(IT)。
    """
    quote, letter = cap[:-1], cap[-1]
    if letter == "1":
        letter = "J" if following[:1].lower() in ("a", "e", "o", "u") else "I"
    return quote + _DROP_CAP_DIGITS.get(letter, letter)


def _is_heading_en(p: dict, words: list[dict], page_char: float, text: str) -> bool:
    """英語の本で、YomiToku が見出しと判定しなかった章題(One など)を見出しとみなすか。

    1 行だけの短い段落で、文で終わらず、字が本文より明らかに大きいもの。
    """
    if page_char <= 0 or len(text) > 60 or "\n" in p["contents"].strip() or text.endswith(SENTENCE_END_EN):
        return False
    x1, y1, x2, y2 = p["box"]
    sizes = [_word_size(w) for w in words if x1 <= _center(w)[0] <= x2 and y1 <= _center(w)[1] <= y2]
    return bool(sizes) and _median(sizes) > page_char * 1.2


def _ruby_marks(line: list[dict], rubies: list[dict], char: float) -> list[tuple[int, int, str]]:
    """行にかかるルビを、行の文字の範囲 [(始まり, 終わり, 読み)] にする。

    行の中の字の位置は断片ごとに均等割りで見積もり、ルビの範囲にかかる漢字の並び
    (いちばん長いもの)を親文字とする。漢字にかからないルビは捨てる。
    """
    centers: list[float] = []
    chars: list[str] = []
    for pc in line:
        text = pc["text"].strip()
        step = (pc["end"] - pc["start"]) / max(len(text), 1)
        for k, c in enumerate(text):
            chars.append(c)
            centers.append(pc["start"] + (k + 0.5) * step)
    marks: list[tuple[int, int, str]] = []
    for r in sorted(rubies, key=lambda r: r["start"]):
        tol = char * 0.3
        covered = [i for i, c in enumerate(centers) if r["start"] - tol <= c <= r["end"] + tol]
        runs: list[list[int]] = []
        for i in covered:
            if not _KANJI_RE.match(chars[i]):
                continue
            if runs and runs[-1][-1] == i - 1:
                runs[-1].append(i)
            else:
                runs.append([i])
        if not runs:
            continue
        run = max(runs, key=len)
        # 熟語の読みは 1 字あたり 2 字ほどまで。読みが長すぎれば、位置の見積もりのずれで
        # 外れた隣の漢字まで広げる(花崗|かこうがん → 花崗岩)。
        wide = char * 0.8
        while len(run) >= 2 and len(r["text"]) > 2 * len(run):
            after, before = run[-1] + 1, run[0] - 1
            if after < len(chars) and _KANJI_RE.match(chars[after]) and centers[after] <= r["end"] + wide:
                run.append(after)
            elif before >= 0 and _KANJI_RE.match(chars[before]) and centers[before] >= r["start"] - wide:
                run.insert(0, before)
            else:
                break
        following = "".join(chars[run[-1] + 1 : run[-1] + 1 + len(r["text"])])
        if following == r["text"]:
            continue  # 本文の送り仮名が小さく読まれたもの(還|って って)
        if marks and run[0] < marks[-1][1]:
            continue  # 前のルビと重なる
        marks.append((run[0], run[-1] + 1, r["text"]))
    return marks


def _line_text(line: list[dict], marks: list[tuple[int, int, str]], lang: str = "ja") -> str:
    if lang == "en":
        return " ".join(pc["text"].strip().replace("―", "—") for pc in line)
    text = "".join(pc["text"].strip() for pc in line)
    for start, end, reading in reversed(marks):
        text = f"{text[:start]}<ruby>{text[start:end]}<rt>{reading}</rt></ruby>{text[end:]}"
    return text


def _split_paragraphs(p: dict, words: list[dict], lang: str = "ja") -> tuple[list[str], bool | None]:
    """YomiToku の段落を、行頭の字下げで本来の段落に分け直す。

    YomiToku は隣り合う段落を 1 つにまとめることがある。行(word)ごとの座標から
    行を組み立て、行頭が 1/2 文字以上下がっている行を新しい段落の始まりとみなす。
    ルビは親文字に <ruby>漢字<rt>かんじ</rt></ruby> として付ける。
    戻り値は (段落のリスト, 先頭行が字下げされているか)。行が 1 本だけなど判断できない
    ときは None。行を取り出せないときは段落全体を 1 つとして返す。
    """
    whole = _text(p, lang)
    x1, y1, x2, y2 = p["box"]
    vertical = p.get("direction") == "vertical"
    pieces = []
    rubies = []
    for w in words:
        cx, cy = _center(w)
        xs = [pt[0] for pt in w["points"]]
        ys = [pt[1] for pt in w["points"]]
        # 縦書き: 行は x、行頭は上端、字の大きさは幅。横書き: 行は y、行頭は左端、字の大きさは高さ。
        if vertical:
            pc = {"cross": cx, "start": min(ys), "end": max(ys), "size": max(xs) - min(xs), "text": w["content"]}
        else:
            pc = {"cross": cy, "start": min(xs), "end": max(xs), "size": max(ys) - min(ys), "text": w["content"]}
        if _KANA_RE.match(pc["text"].strip()):
            # ルビの候補(かなだけの行)。段落の最初の行のルビは段落の枠の外に出るので、少し広げて拾う。
            m = pc["size"] * 2
            if x1 - m <= cx <= x2 + m and y1 - m <= cy <= y2 + m:
                rubies.append(pc)
        if not (x1 <= cx <= x2 and y1 <= cy <= y2):
            continue
        if (w.get("direction") == "vertical") != vertical:
            continue
        pieces.append(pc)
    if not pieces:
        return [whole], None
    sizes = sorted(pc["size"] for pc in pieces)
    char = sizes[len(sizes) // 2] or 1
    # ルビ(本文の半分ほどの小さい字)は本文に入れない。
    pieces = [pc for pc in pieces if pc["size"] >= char * 0.7]
    rubies = [r for r in rubies if r["size"] < char * 0.7]
    # 同じ行の断片(囲み文字などで分かれたもの)をまとめ、行を読み順に並べる。
    pieces.sort(key=lambda pc: -pc["cross"] if vertical else pc["cross"])
    lines: list[list[dict]] = []
    for pc in pieces:
        if lines and abs(pc["cross"] - lines[-1][0]["cross"]) < char * 0.6:
            lines[-1].append(pc)
        else:
            lines.append([pc])
    # ルビは親の行の右(縦書き)・上(横書き)に付く。いちばん近い行に割り当てる。
    ruby_of: dict[int, list[dict]] = {}
    for r in rubies:
        best = None
        for n, line in enumerate(lines):
            gap = (r["cross"] - line[0]["cross"]) if vertical else (line[0]["cross"] - r["cross"])
            if 0 < gap < char * 1.2 and (best is None or gap < best[1]):
                best = (n, gap)
        if best is not None:
            ruby_of.setdefault(best[0], []).append(r)
    rows = []
    for n, line in enumerate(lines):
        line.sort(key=lambda pc: pc["start"])
        marks = _ruby_marks(line, ruby_of.get(n, []), char)
        rows.append((line[0]["start"], _line_text(line, marks, lang)))
    base = min(start for start, _ in rows)
    paras: list[str] = []
    in_item = False  # 英語の本の番号付き・箇条書きの項目の中(2 行目以降はぶら下げで字下げされる)
    for i, (start, text) in enumerate(rows):
        indented = start - base > char * 0.5
        if lang == "en" and _LIST_ITEM_RE.match(text):
            paras.append(text)
            in_item = True
        elif lang == "en" and in_item and indented:
            paras[-1] = _join(paras[-1], text, lang)
        elif i == 0 or indented:
            paras.append(text)
            in_item = False
        else:
            paras[-1] = _join(paras[-1], text, lang)
            in_item = False
    # 行の取り出しが段落の中身と食い違う(字が欠ける)ときは分割をあきらめる。
    got = re.sub(r"\s", "", _RUBY_TAG_RE.sub("", "".join(paras)))
    want = re.sub(r"\s", "", whole)
    if abs(len(got) - len(want)) > max(2, len(want) // 20):
        return [whole], None
    first_indented = rows[0][0] - base > char * 0.5 if len(rows) >= 2 else None
    return [t for t in paras if t], first_indented


def _low_confidence(
    words: list[dict], paragraphs: list[dict], page_char: float, markdown: str
) -> list[dict]:
    """本文の中で読み取りの確信度が低い行 [{text, score}](要確認の候補)。"""
    out = []
    for w in words:
        score = float(w.get("rec_score", 1.0))
        text = (w.get("content") or "").strip()
        if score >= _LOW_SCORE or len(text) < 2:
            continue
        if page_char > 0 and _word_size(w) < page_char * 0.7:
            continue  # ルビ
        cx, cy = _center(w)
        if not any(p["box"][0] <= cx <= p["box"][2] and p["box"][1] <= cy <= p["box"][3] for p in paragraphs):
            continue  # 本文以外(柱・ページ表示・図の中の文字)
        if text in markdown:
            out.append({"text": text, "score": round(score, 2)})
    return out


def transcribe(image_bytes: bytes, lang: str = "ja") -> tuple[str, list[Figure], list[dict], bool]:
    """画像を文字起こしし、(Markdown, 図のリスト, 確信度の低い行, 先頭が前ページの続きか) を返す。

    lang は本の言語("ja" / "en")。英語では行を空白でつなぎ、文の終わり・キャプション・
    場面転換・飾り頭文字を英語の本の決まりで扱う。
    Markdown 中の図は ![キャプション](FIGURE:k) の仮参照で、k は図のリストの添字。
    呼び出し側が保存先に合わせて置き換える。
    「先頭が前ページの続きか」は、最初の要素が字下げなしで始まる本文の段落のとき True
    (前のページの段落が文の途中で終わっていれば、つなぐ候補になる)。
    """
    import cv2
    import numpy as np

    img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        # OpenCV が読めない形式(GIF など)は Pillow で開き直す。
        try:
            from io import BytesIO

            from PIL import Image

            with Image.open(BytesIO(image_bytes)) as im:
                img = cv2.cvtColor(np.asarray(im.convert("RGB")), cv2.COLOR_RGB2BGR)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"画像を読み込めません: {e}") from e
    analyzer = _get_analyzer()
    with _lock:  # モデルはスレッドセーフとは限らないので直列に使う
        result, _, _ = analyzer(img)
    data = result.model_dump()

    # 図と表はどちらも画像として切り抜く(表の Markdown 化は後で)。
    # ただし文字の入った横長の帯(節見出しの飾り枠など)は、図ではなく見出しとして扱う。
    regions = []
    banners = []
    for f in data.get("figures", []):
        x1, y1, x2, y2 = f["box"]
        inner = " ".join(_text(p, lang) for p in f.get("paragraphs", []) if _text(p, lang))
        if inner and (x2 - x1) > (y2 - y1) * _BANNER_RATIO:
            # ページ上端の帯は欄外の章名(柱)なので本文に入れない。
            if y2 < img.shape[0] * 0.1:
                continue
            banners.append({"order": (f.get("order", 0), 0), "kind": "p", "text": inner,
                            "role": "section_headings", "continues": False})
        else:
            # 図の中の文字(章の扉の題名、図として取られた目次など)は、キャプションが無いときに使う。
            regions.append({"box": f["box"], "order": f.get("order", 0), "inner": inner})
    regions += [{"box": t["box"], "order": t.get("order", 0)} for t in data.get("tables", [])]

    words = data.get("words", [])
    page_char = _median([_word_size(w) for w in words])
    paragraphs = [
        p
        for p in data.get("paragraphs", [])
        if p.get("role") not in ("page_header", "page_footer")
        # 英語の本にルビは無い(小さい字の短い段落はスモールキャピタルなどの本文)
        and not (lang != "en" and _is_ruby_only(p, words, page_char))
    ]
    sentence_end = SENTENCE_END_EN if lang == "en" else SENTENCE_END
    caption_re = _CAPTION_RE_EN if lang == "en" else _CAPTION_RE
    # 英語の飾り頭文字(大きな 1 字の段落)は、右に接する段落の頭に付け直す(I + T WAS → IT WAS)。
    drop_caps: dict[int, str] = {}  # 段落の id() → 頭に付ける字
    if lang == "en" and page_char > 0:
        caps = []
        for p in paragraphs:
            m = _DROP_CAP_RE.match(_text(p, lang))
            x1, y1, x2, y2 = p["box"]
            if not (m and y2 - y1 > page_char * _DROP_CAP_RATIO):
                continue
            text = m.group(1) + m.group(2)
            for q in paragraphs:
                # 頭文字の右へ続き、縦の範囲が重なる段落(頭文字の下の行の分、左端は頭文字と揃う)
                qx1, qy1, qx2, qy2 = q["box"]
                if q is not p and qx1 <= x2 + page_char * 2 and qx2 > x2 + page_char and qy1 <= y2 and qy2 >= y1:
                    drop_caps[id(q)] = text
                    caps.append(p)  # 頭文字の段落そのものは出さない
                    break
        paragraphs = [p for p in paragraphs if not any(p is c for c in caps)]
    # キャプションの判定: 図(またはキャプション)に接していて、図番号で始まるか、
    # 「。」で終わらない短い段落(見出しは除く)。キャプションに接した段落も同じ図のものとして連ねる。
    captions: dict[int, list[str]] = {}
    caption_of: dict[int, int] = {}  # 段落の添字 → 図の添字
    changed = True
    while changed:
        changed = False
        for k, p in enumerate(paragraphs):
            if k in caption_of:
                continue
            text = _text(p, lang)
            if not text:
                continue
            likely = caption_re.match(text) or (
                len(text) < 120
                and not text.endswith(sentence_end if lang == "en" else "。")
                and p.get("role") != "section_headings"
            )
            if not likely:
                continue
            near = [i for i, r in enumerate(regions) if _overlaps(p["box"], r["box"], _CAPTION_MARGIN)]
            near += [
                caption_of[j]
                for j in caption_of
                if _overlaps(p["box"], paragraphs[j]["box"], _CAPTION_MARGIN // 3)
            ]
            if near:
                caption_of[k] = near[0]
                changed = True
    for k in sorted(caption_of, key=lambda j: paragraphs[j].get("order", 0)):
        captions.setdefault(caption_of[k], []).append(_text(paragraphs[k], lang))

    body: list[dict] = list(banners)
    for k, p in enumerate(paragraphs):
        if k in caption_of or not _text(p, lang):
            continue
        role = p.get("role")
        if lang == "en":
            text = _text(p, lang)
            if _SCENE_BREAK_RE.match(text):
                # 場面転換の飾りは区切りの印にする(前後の段落はつながない)
                body.append({"order": (p.get("order", 0), 0), "kind": "break", "text": "***"})
                continue
            if len(text) <= 2 and not re.search(r"[A-Za-z0-9]", text):
                continue  # 記号の読み違い(箇条書きの点を「ド」と読むなど)
            if role == "section_headings" and text.endswith(sentence_end):
                role = None  # 文で終わる短い段落を見出しと取り違えたもの(And it would continue to.)
            elif role is None and _is_heading_en(p, words, page_char, text):
                role = "section_headings"
        if role == "section_headings":
            texts, first_indented = [_text(p, lang)], True
        else:
            texts, first_indented = _split_paragraphs(p, words, lang)
        if id(p) in drop_caps and texts:
            texts[0] = _drop_cap_text(drop_caps[id(p)], texts[0]) + texts[0]
        if lang == "en":
            # 箇条書きの記号(· ・ •)は Markdown のリストにする。記号の前に読み違いの字が付くことがある
            texts = [_BULLET_RE.sub("- ", t) for t in texts]
        for n, text in enumerate(texts):
            body.append(
                {
                    "order": (p.get("order", 0), n),
                    "kind": "p",
                    "text": text,
                    "role": role,
                    # 字下げなしで始まる先頭の段落は、前の段落(前ページ・前の列)の続きの可能性がある
                    "continues": n == 0 and first_indented is not True,
                }
            )

    figures: list[Figure] = []

    def _keep_captions(i: int) -> None:
        # 図にしない領域(小さすぎる飾りなど)のキャプションは、本文の段落として残す
        # (章の扉の題名や短い引用が黙って消えないように)。
        for n, text in enumerate(captions.get(i, [])):
            body.append(
                {
                    "order": (regions[i].get("order", 0), n),
                    "kind": "p",
                    "text": text,
                    "role": None,
                    "continues": False,
                }
            )

    for i, r in enumerate(regions):
        x1, y1, x2, y2 = (int(v) for v in r["box"])
        # 章番号の飾りなど、小さすぎる領域は図として扱わない。
        if x2 - x1 < _MIN_FIGURE_PX and y2 - y1 < _MIN_FIGURE_PX:
            _keep_captions(i)
            continue
        crop = img[max(0, y1) : y2, max(0, x1) : x2]
        if crop.size == 0:
            _keep_captions(i)
            continue
        ok, buf = cv2.imencode(".png", crop)
        if not ok:
            _keep_captions(i)
            continue
        caption = " ".join(captions.get(i, []))
        if not caption and r.get("inner"):
            # キャプションの無い図は、図の中の文字で代える(章の扉・目次を本文データに残すため)。
            caption = r["inner"][:_INNER_TEXT_MAX]
        body.append({"order": (r["order"], 0), "kind": "fig", "index": len(figures), "text": caption})
        figures.append(Figure(png=buf.tobytes(), caption=caption))

    lines: list[str] = []
    last_text: int | None = None  # 直近の本文段落の位置(見出しをまたいだらつながない)
    ordered = sorted(body, key=lambda b: b["order"])
    head_continues = bool(
        ordered
        and ordered[0]["kind"] == "p"
        and ordered[0]["role"] != "section_headings"
        and ordered[0]["continues"]
    )
    for item in ordered:
        if item["kind"] == "break":
            lines.append(item["text"])
            last_text = None
        elif item["kind"] == "fig":
            alt = item["text"].replace("[", "(").replace("]", ")")
            lines.append(f"![{alt}](FIGURE:{item['index']})")
        elif item["role"] == "section_headings":
            lines.append(f"## {item['text']}")
            last_text = None
        elif (
            item["continues"]
            and last_text is not None
            and not lines[last_text].endswith(sentence_end)
            and not (lang == "en" and item["text"].startswith("- "))
        ):
            # 文の途中で段落が切れている(見開きの境目・図をはさんだ続きなど)ので前の段落につなぐ。
            lines[last_text] = _join(lines[last_text], item["text"], lang)
        else:
            lines.append(item["text"])
            last_text = len(lines) - 1
    markdown = "\n\n".join(lines)
    return markdown, figures, _low_confidence(words, paragraphs, page_char, markdown), head_continues
