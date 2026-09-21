"""YomiToku(日本語の文書 OCR + レイアウト解析)による文字起こし。

1 枚の画像から、読み順に並んだ段落・見出し・図の領域を取り出し、Markdown に変換する。
図は元画像から切り抜いて返し、Markdown では ![キャプション](../figures/…) で参照する。

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
# 幅が高さのこの倍を超え、中に文字がある「図」は見出しの帯とみなす。
_BANNER_RATIO = 4
# 段落がここで終わっていれば、次の段落とはつながない。
_SENTENCE_END = ("。", "」", "』", ")", "）", "！", "？", "!", "?")
_CAPTION_RE = re.compile(r"^\s*(図|表|写真|グラフ)\s*[0-9０-９]")


@dataclass
class Figure:
    """切り抜いた図。name は Markdown で参照するファイル名(拡張子なし部分は呼び出し側で決める)。"""

    png: bytes
    caption: str


def available() -> bool:
    try:
        import yomitoku  # noqa: F401
    except ImportError:
        return False
    return True


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
            # 書名バー・ページ表示(ヘッダー/フッター)は本文に入れない。ルビは今は落とす。
            _analyzer = DocumentAnalyzer(device=device, ignore_meta=True, ignore_ruby=True)
        return _analyzer


def _overlaps(a: list[int], b: list[int], margin: int) -> bool:
    return not (
        a[2] < b[0] - margin or a[0] > b[2] + margin or a[3] < b[1] - margin or a[1] > b[3] + margin
    )


def _text(p: dict) -> str:
    # 紙面の折り返し改行は取り除く(日本語の本なので空白は足さない)。
    return re.sub(r"\s*\n\s*", "", p["contents"]).strip()


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


def _split_paragraphs(p: dict, words: list[dict]) -> tuple[list[str], bool | None]:
    """YomiToku の段落を、行頭の字下げで本来の段落に分け直す。

    YomiToku は隣り合う段落を 1 つにまとめることがある。行(word)ごとの座標から
    行を組み立て、行頭が 1/2 文字以上下がっている行を新しい段落の始まりとみなす。
    戻り値は (段落のリスト, 先頭行が字下げされているか)。行が 1 本だけなど判断できない
    ときは None。行を取り出せないときは段落全体を 1 つとして返す。
    """
    whole = _text(p)
    x1, y1, x2, y2 = p["box"]
    vertical = p.get("direction") == "vertical"
    pieces = []
    for w in words:
        cx, cy = _center(w)
        if not (x1 <= cx <= x2 and y1 <= cy <= y2):
            continue
        if (w.get("direction") == "vertical") != vertical:
            continue
        xs = [pt[0] for pt in w["points"]]
        ys = [pt[1] for pt in w["points"]]
        # 縦書き: 行は x、行頭は上端、字の大きさは幅。横書き: 行は y、行頭は左端、字の大きさは高さ。
        if vertical:
            pieces.append({"cross": cx, "start": min(ys), "size": max(xs) - min(xs), "text": w["content"]})
        else:
            pieces.append({"cross": cy, "start": min(xs), "size": max(ys) - min(ys), "text": w["content"]})
    if not pieces:
        return [whole], None
    sizes = sorted(pc["size"] for pc in pieces)
    char = sizes[len(sizes) // 2] or 1
    # ルビ(本文の半分ほどの小さい字)は本文に入れない。
    pieces = [pc for pc in pieces if pc["size"] >= char * 0.7]
    # 同じ行の断片(囲み文字などで分かれたもの)をまとめ、行を読み順に並べる。
    pieces.sort(key=lambda pc: -pc["cross"] if vertical else pc["cross"])
    lines: list[list[dict]] = []
    for pc in pieces:
        if lines and abs(pc["cross"] - lines[-1][0]["cross"]) < char * 0.6:
            lines[-1].append(pc)
        else:
            lines.append([pc])
    rows = []
    for line in lines:
        line.sort(key=lambda pc: pc["start"])
        rows.append((line[0]["start"], "".join(pc["text"].strip() for pc in line)))
    base = min(start for start, _ in rows)
    paras: list[str] = []
    for i, (start, text) in enumerate(rows):
        if i == 0 or start - base > char * 0.5:
            paras.append(text)
        else:
            paras[-1] += text
    # 行の取り出しが段落の中身と食い違う(字が欠ける)ときは分割をあきらめる。
    if abs(len("".join(paras)) - len(whole)) > max(2, len(whole) // 20):
        return [whole], None
    first_indented = rows[0][0] - base > char * 0.5 if len(rows) >= 2 else None
    return [t for t in paras if t], first_indented


def transcribe(image_bytes: bytes) -> tuple[str, list[Figure]]:
    """画像を文字起こしし、(Markdown, 図のリスト) を返す。

    Markdown 中の図は ![キャプション](FIGURE:k) の仮参照で、k は図のリストの添字。
    呼び出し側が保存先に合わせて置き換える。
    """
    import cv2
    import numpy as np

    img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError("画像を読み込めません")
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
        inner = "".join(_text(p) for p in f.get("paragraphs", []))
        if inner and (x2 - x1) > (y2 - y1) * _BANNER_RATIO:
            # ページ上端の帯は欄外の章名(柱)なので本文に入れない。
            if y2 < img.shape[0] * 0.1:
                continue
            banners.append({"order": (f.get("order", 0), 0), "kind": "p", "text": inner,
                            "role": "section_headings", "continues": False})
        else:
            regions.append({"box": f["box"], "order": f.get("order", 0)})
    regions += [{"box": t["box"], "order": t.get("order", 0)} for t in data.get("tables", [])]

    words = data.get("words", [])
    page_char = _median([_word_size(w) for w in words])
    paragraphs = [
        p
        for p in data.get("paragraphs", [])
        if p.get("role") not in ("page_header", "page_footer") and not _is_ruby_only(p, words, page_char)
    ]
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
            text = _text(p)
            if not text:
                continue
            likely = _CAPTION_RE.match(text) or (
                len(text) < 120 and not text.endswith("。") and p.get("role") != "section_headings"
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
        captions.setdefault(caption_of[k], []).append(_text(paragraphs[k]))

    body: list[dict] = list(banners)
    for k, p in enumerate(paragraphs):
        if k in caption_of or not _text(p):
            continue
        role = p.get("role")
        if role == "section_headings":
            texts, first_indented = [_text(p)], True
        else:
            texts, first_indented = _split_paragraphs(p, words)
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
    for i, r in enumerate(regions):
        x1, y1, x2, y2 = (int(v) for v in r["box"])
        # 章番号の飾りなど、小さすぎる領域は図として扱わない。
        if x2 - x1 < _MIN_FIGURE_PX and y2 - y1 < _MIN_FIGURE_PX:
            continue
        crop = img[max(0, y1) : y2, max(0, x1) : x2]
        if crop.size == 0:
            continue
        ok, buf = cv2.imencode(".png", crop)
        if not ok:
            continue
        caption = " ".join(captions.get(i, []))
        body.append({"order": (r["order"], 0), "kind": "fig", "index": len(figures), "text": caption})
        figures.append(Figure(png=buf.tobytes(), caption=caption))

    lines: list[str] = []
    last_text: int | None = None  # 直近の本文段落の位置(見出しをまたいだらつながない)
    for item in sorted(body, key=lambda b: b["order"]):
        if item["kind"] == "fig":
            alt = item["text"].replace("[", "(").replace("]", ")")
            lines.append(f"![{alt}](FIGURE:{item['index']})")
        elif item["role"] == "section_headings":
            lines.append(f"## {item['text']}")
            last_text = None
        elif (
            item["continues"]
            and last_text is not None
            and not lines[last_text].endswith(_SENTENCE_END)
        ):
            # 文の途中で段落が切れている(見開きの境目・図をはさんだ続きなど)ので前の段落につなぐ。
            lines[last_text] += item["text"]
        else:
            lines.append(item["text"])
            last_text = len(lines) - 1
    return "\n\n".join(lines), figures
