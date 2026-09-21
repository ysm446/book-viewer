"""ページ画像の文字起こし(→ Markdown)。

1 枚のスクリーンショット(= アーカイブ内の 1 ページ。見開き 2 ページのこともある)ごとに
本文を Markdown に書き起こし、本フォルダの pages/0001.md … に保存する(本文の正本)。

エンジンは 2 つ(比較は scripts/ocr-compare/):
- yomitoku(既定): 文書 OCR + レイアウト解析(layout_ocr.py)。字の書き換えが少なく速い。
  図・表は切り抜いて figures/p0001-1.png … に保存し、![キャプション](../figures/…) で参照する。
- vlm: 読み込み済みの Vision LLM に画像ごと書き起こさせる。図はキャプションだけを残す。
"""

from __future__ import annotations

import base64
import io
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from PIL import Image

from . import archive, layout_ocr, library, llm
from .progress import Cancelled, clear_progress, set_progress
from .db import connect

PAGES_DIRNAME = "pages"
FIGURES_DIRNAME = "figures"
ENGINES = ("yomitoku", "vlm")

# 文字を読むためチャットの画像(1024px)より大きく送る。スクリーンショットは長辺 1500px 前後で
# 本文の字が小さいため、最大 1.5 倍まで拡大してから渡す(誤読が減る)。
_TRANSCRIBE_MAX = 2304
_UPSCALE_MAX = 1.5

_COMMON_RULES = """\
- 出力は Markdown の本文だけ。前置き・説明・コードフェンス(```)で囲むことはしない。
- 画像は電子書籍リーダーの画面のスクリーンショット。次のものは本文ではないので出力しない:
  画面上部の書名・ウィンドウのタイトル、画面下部の「ページ○/○」や進捗(%)、
  ページ番号(ノンブル)、欄外の章名(柱)、画面の端に写り込んだ別のウィンドウ。
- 本文の文字は一字一句そのまま書き写す。要約・言い換え・補完・翻訳をしない。
  語尾や送り仮名も変えない。本は日本語なので、画像に無い字(中国語の表記など)を混ぜない。
  読めない字は〓にする。
- 見出しは大きさに応じて #, ##, ### を付ける(章は #、節は ##、小見出しは ###)。
- 段落は空行で区切る。紙面の折り返しで入った改行は取り除き、1 段落を 1 行にする。
- 箇条書き・番号付きの項目は Markdown のリストにする。表は Markdown の表にする。
- 数式は $...$ で書く。プログラムのコードは ``` で囲むコードブロックにする。
- 図・写真・グラフ・イラストは中の文字を書き写さず、1 行で [図: キャプション] と書く
  (例: [図: 図2-11 層状雲から降る雨のしくみ])。キャプションはこの中にだけ書き、
  別の行に繰り返さない。キャプションが無ければ [図: 内容の短い説明] とする。
- ルビ(ふりがな)は <ruby>漢字<rt>かんじ</rt></ruby> の形で書く。
- 本文が何も無い画面(白紙・表紙の絵だけ等)は、何も出力しない。
"""

_HORIZONTAL = """\
この画面の本文を Markdown に書き起こしてください。本は横書きです。
- 見開き(左右 2 ページ)のときは、左のページを最後まで読んでから右のページへ進む。
"""

_VERTICAL = """\
この画面の本文を Markdown に書き起こしてください。本は縦書きです。
- 縦書きの行は右から左へ読む。見開き(左右 2 ページ)のときは、右のページを最後まで
  読んでから左のページへ進む。
- 縦中横(縦書きの中に横に並んだ数字など)は普通の横書きの文字として書く。
- 傍点(文字の横の点)は **太字** にする。
"""


class TranscribeError(RuntimeError):
    pass


# ---- LLM に渡す本文(チャット・要約・検索で共通) ----

_IMAGE_REF_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_RT_RE = re.compile(r"<rt>.*?</rt>")
_TAG_RE = re.compile(r"</?ruby>")
_HEADING_RE = re.compile(r"^#{1,6}\s+(.+)$", re.MULTILINE)


def plain_for_llm(markdown: str) -> str:
    """本文の Markdown を LLM に渡す形にする。

    図は [図: キャプション]、ルビは落とす。本文中の見出し(## …)は【…】にする
    (system 側の「## 本文」などの区切りと紛れないように)。
    """
    text = _IMAGE_REF_RE.sub(lambda m: f"[図: {m.group(1)}]" if m.group(1) else "[図]", markdown)
    text = _RT_RE.sub("", text)
    text = _HEADING_RE.sub(lambda m: f"【{m.group(1).strip()}】", text)
    return _TAG_RE.sub("", text).strip()


def prompt(writing_mode: str) -> str:
    head = _VERTICAL if writing_mode == "vertical" else _HORIZONTAL
    return head + "\n守ること:\n" + _COMMON_RULES


def _data_url(raw: bytes) -> str:
    with Image.open(io.BytesIO(raw)) as img:
        img = img.convert("RGB")
        scale = min(_UPSCALE_MAX, _TRANSCRIBE_MAX / max(img.size))
        if abs(scale - 1) > 0.01:
            size = (round(img.width * scale), round(img.height * scale))
            img = img.resize(size, Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


_FENCE_RE = re.compile(r"^```(?:markdown|md)?\s*\n(.*?)\n```\s*$", re.DOTALL)


def clean_output(text: str) -> str:
    """モデルが全体をコードフェンスで囲んだ場合などを取り除く。"""
    text = text.strip()
    m = _FENCE_RE.match(text)
    if m:
        text = m.group(1).strip()
    return text


def _book(root: Path, work_id: str) -> tuple[Path, Path, dict]:
    """(本フォルダ, 元アーカイブ, works 行) を返す。本フォルダ方式でなければエラー。"""
    with connect(root) as conn:
        row = conn.execute(
            "SELECT rel_path, writing_mode, page_count FROM works WHERE id = ?", (work_id,)
        ).fetchone()
    if row is None:
        raise TranscribeError("本が見つかりません")
    book_dir = library.book_dir_for(root, row["rel_path"])
    if book_dir is None:
        raise TranscribeError("本フォルダに取り込んだ本だけ文字起こしできます")
    return book_dir, root / row["rel_path"], dict(row)


def page_path(book_dir: Path, index: int) -> Path:
    """0 始まりのページ番号 → pages/0001.md(ファイル名は 1 始まり)。"""
    return book_dir / PAGES_DIRNAME / f"{index + 1:04d}.md"


def meta_path(book_dir: Path, index: int) -> Path:
    """ページの補助情報 pages/0001.json(エンジン・確信度の低い行・手で直したか)。"""
    return book_dir / PAGES_DIRNAME / f"{index + 1:04d}.json"


def _read_meta(book_dir: Path, index: int) -> dict:
    try:
        data = json.loads(meta_path(book_dir, index).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_meta(book_dir: Path, index: int, meta: dict) -> None:
    path = meta_path(book_dir, index)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def read_page(root: Path, work_id: str, index: int) -> dict | None:
    """編集画面用: {markdown, low(確信度の低い行), edited(手で直したか)}。未処理なら None。"""
    book_dir, _, _ = _book(root, work_id)
    path = page_path(book_dir, index)
    if not path.is_file():
        return None
    meta = _read_meta(book_dir, index)
    return {
        "markdown": path.read_text(encoding="utf-8"),
        "low": meta.get("low") or [],
        "edited": bool(meta.get("edited")),
    }


def save_text(root: Path, work_id: str, index: int, markdown: str) -> dict:
    """手で直した本文を保存する。以後「全ページやり直す」では上書きしない。"""
    book_dir, _, row = _book(root, work_id)
    if not 0 <= index < row["page_count"]:
        raise TranscribeError("ページが範囲外です")
    text = markdown.replace("\r\n", "\n").strip()
    _write(page_path(book_dir, index), text)
    meta = _read_meta(book_dir, index)
    # 直した行は要確認から外す(元の文字列のまま残っている行だけ残す)。
    meta["low"] = [x for x in meta.get("low") or [] if x.get("text") and x["text"] in text]
    meta["edited"] = True
    meta["updated_at"] = datetime.now(timezone.utc).isoformat()
    _write_meta(book_dir, index, meta)
    return read_page(root, work_id, index) or {}


_FIGURE_NAME_RE = re.compile(r"^p\d{4}-\d+\.png$")


def figure_path(root: Path, work_id: str, name: str) -> Path | None:
    """figures/ の図のパス。名前は決まった形だけ受け付ける(本フォルダの外へ出させない)。"""
    if not _FIGURE_NAME_RE.match(name):
        return None
    book_dir, _, _ = _book(root, work_id)
    path = book_dir / FIGURES_DIRNAME / name
    return path if path.is_file() else None


def read_text(root: Path, work_id: str, index: int) -> str | None:
    book_dir, _, _ = _book(root, work_id)
    path = page_path(book_dir, index)
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8")


def done_pages(root: Path, work_id: str) -> list[int]:
    """文字起こし済みのページ番号(0 始まり)。"""
    book_dir, _, _ = _book(root, work_id)
    d = book_dir / PAGES_DIRNAME
    if not d.is_dir():
        return []
    out = []
    for p in d.glob("*.md"):
        if p.stem.isdigit():
            out.append(int(p.stem) - 1)
    return sorted(out)


# ---- ページをまたぐ段落のつなぎ ----

_BLOCK_RE = re.compile(r"\n\s*\n")
# 本文の段落ではないブロック(見出し・図・表・リスト・引用・コード・数式)。
_NOT_PROSE_RE = re.compile(r"^(#|!\[|\||[-*+]\s|\d+\.\s|>|```|\$\$)")
_END_MARKUP_RE = re.compile(r"(</?ruby>|<rt>.*?</rt>|\*+)$")
# 前のページの最後の段落がこれより短ければ、句読点が無くても文章の書き出しとみなす。
_SHORT_TAIL = 30


def _ends_mid_sentence(block: str) -> bool:
    text = block.strip()
    while True:  # 末尾のルビや太字の記号は文の終わりの判定に使わない
        stripped = _END_MARKUP_RE.sub("", text).rstrip()
        if stripped == text:
            break
        text = stripped
    return bool(text) and not text.endswith(layout_ocr.SENTENCE_END)


def joins_previous(prev_markdown: str, markdown: str, head_continues: bool | None = None) -> bool:
    """このページの最初の段落が、前のページの最後の段落の続きか。

    前のページが本文の段落で終わっていて文の途中(「。」などで終わらない)、このページが
    本文の段落で始まるときに続きとみなす。YomiToku で読んだページは、先頭が字下げされて
    いれば(head_continues=False)新しい段落なのでつながない。
    """
    if head_continues is False:
        return False
    prev_blocks = [b for b in _BLOCK_RE.split(prev_markdown.strip()) if b.strip()]
    blocks = [b for b in _BLOCK_RE.split(markdown.strip()) if b.strip()]
    if not prev_blocks or not blocks:
        return False
    last, first = prev_blocks[-1].strip(), blocks[0].strip()
    if _NOT_PROSE_RE.match(last) or _NOT_PROSE_RE.match(first):
        return False
    # 句読点の無い並び(奥付・目次・参考文献・表の文字)は文章ではないのでつながない。
    # 前のページ側が短い(最後の行で始まった段落)ときは句読点が無くてもよい。
    if "。" not in last + first:
        return False
    tail = _TAG_RE.sub("", _RT_RE.sub("", last))
    if len(tail) >= _SHORT_TAIL and "、" not in tail and "。" not in tail:
        return False
    return _ends_mid_sentence(last)


def join_pages(root: Path, work_id: str, texts: dict[int, str]) -> dict[int, str]:
    """ページごとの本文(Markdown)の、ページをまたいで切れた段落をつないだものを返す。

    続きの部分(次のページの最初の段落)は前のページの最後の段落に寄せる。つなぐのは
    texts に前後のページが両方あるときだけ(渡していない先のページの文は持ち込まない)。
    ページのファイル(本文の正本)は変えない。LLM・索引・検索に渡す本文に使う。
    """
    book_dir, _, _ = _book(root, work_id)
    out = dict(texts)
    for p in sorted(texts):
        if p - 1 not in out:
            continue
        head = _read_meta(book_dir, p).get("head_continues")
        if not joins_previous(out[p - 1], out[p], head):
            continue
        prev_blocks = _BLOCK_RE.split(out[p - 1].rstrip())
        first, *rest = _BLOCK_RE.split(out[p].strip(), maxsplit=1)
        tail = prev_blocks[-1].rstrip()
        # 英単語どうしが切れていたら空白を入れる(日本語は詰める)。
        sep = " " if tail[-1:].isascii() and tail[-1:].isalnum() and first[:1].isascii() and first[:1].isalnum() else ""
        prev_blocks[-1] = tail + sep + first.strip()
        out[p - 1] = "\n\n".join(prev_blocks)
        out[p] = rest[0] if rest else ""
    return out


def _figure_name(index: int, k: int) -> str:
    return f"p{index + 1:04d}-{k + 1}.png"


def _transcribe_yomitoku(book_dir: Path, index: int, raw: bytes) -> tuple[str, list[dict], bool]:
    """YomiToku で文字起こしし、図を figures/ に保存した (Markdown, 確信度の低い行, 先頭が続きか) を返す。"""
    markdown, figures, low, head_continues = layout_ocr.transcribe(raw)
    fig_dir = book_dir / FIGURES_DIRNAME
    # やり直しのときに前回の図が残らないよう、このページの図を消してから書く。
    for old in fig_dir.glob(f"p{index + 1:04d}-*.png"):
        old.unlink(missing_ok=True)
    for k, fig in enumerate(figures):
        fig_dir.mkdir(parents=True, exist_ok=True)
        name = _figure_name(index, k)
        (fig_dir / name).write_bytes(fig.png)
        markdown = markdown.replace(f"(FIGURE:{k})", f"(../{FIGURES_DIRNAME}/{name})")
    return markdown, low, head_continues


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".md.tmp")
    tmp.write_text(text + "\n" if text else "", encoding="utf-8")
    tmp.replace(path)


def transcribe_pages(
    root: Path,
    work_id: str,
    base_url: str | None,
    pages: list[int] | None = None,
    *,
    engine: str = "yomitoku",
    force: bool = False,
    cancel_check: Callable[[], bool] | None = None,
) -> int:
    """指定ページ(省略時は未処理の全ページ)を文字起こしして保存し、処理したページ数を返す。

    force=False なら既に Markdown があるページは飛ばす。force=True でも pages を省略したとき
    (全ページのやり直し)は、手で直したページは飛ばす。ページを指定したときは上書きする。
    engine="vlm" のときは base_url(読み込み済みの llama-server)が必要。
    """
    if engine not in ENGINES:
        raise TranscribeError(f"未対応の文字起こしエンジンです: {engine}")
    if engine == "vlm" and not base_url:
        raise TranscribeError("Vision LLM で文字起こしするには、先にモデルを読み込んでください。")
    book_dir, archive_path, row = _book(root, work_id)
    count = row["page_count"]
    targets = list(range(count)) if pages is None else [p for p in pages if 0 <= p < count]
    if not force:
        targets = [p for p in targets if not page_path(book_dir, p).exists()]
    elif pages is None:
        targets = [p for p in targets if not _read_meta(book_dir, p).get("edited")]
    total = len(targets)
    text_prompt = prompt(row["writing_mode"])
    set_progress(work_id, 0, total, "transcribe")
    try:
        for n, idx in enumerate(targets):
            if cancel_check and cancel_check():
                raise Cancelled()
            raw, _ = archive.read_page(archive_path, idx)
            low: list[dict] = []
            head_continues: bool | None = None  # VLM では分からない(本文だけで判断する)
            if engine == "yomitoku":
                text, low, head_continues = _transcribe_yomitoku(book_dir, idx, raw)
            else:
                out = llm.chat(
                    base_url,
                    [llm.image_message(text_prompt, _data_url(raw))],
                    temperature=0.0,
                    think=False,
                )
                text = clean_output(out)
            _write(page_path(book_dir, idx), text)
            meta = {
                "engine": engine,
                "low": low,
                "edited": False,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            if head_continues is not None:
                meta["head_continues"] = head_continues
            _write_meta(book_dir, idx, meta)
            set_progress(work_id, n + 1, total, "transcribe")
    finally:
        clear_progress(work_id)
    return total
