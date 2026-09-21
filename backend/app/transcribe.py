"""ページ画像の文字起こし(Vision LLM → Markdown)。

1 枚のスクリーンショット(= アーカイブ内の 1 ページ。見開き 2 ページのこともある)ごとに
本文を Markdown に書き起こし、本フォルダの pages/0001.md … に保存する(本文の正本)。
図・表の切り抜きは後の段階で行うため、今は図の位置にキャプションだけを残す。
"""

from __future__ import annotations

import base64
import io
import re
from pathlib import Path
from typing import Callable

from PIL import Image

from . import archive, library, llm
from .analysis import Cancelled, clear_progress, set_progress
from .db import connect

PAGES_DIRNAME = "pages"

# 文字を読むため解析(1024px)より大きく送る。スクリーンショットは長辺 1500px 前後で
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


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".md.tmp")
    tmp.write_text(text + "\n" if text else "", encoding="utf-8")
    tmp.replace(path)


def transcribe_pages(
    root: Path,
    work_id: str,
    base_url: str,
    pages: list[int] | None = None,
    *,
    force: bool = False,
    cancel_check: Callable[[], bool] | None = None,
) -> int:
    """指定ページ(省略時は未処理の全ページ)を文字起こしして保存し、処理したページ数を返す。

    force=False なら既に Markdown があるページは飛ばす。
    """
    book_dir, archive_path, row = _book(root, work_id)
    count = row["page_count"]
    targets = list(range(count)) if pages is None else [p for p in pages if 0 <= p < count]
    if not force:
        targets = [p for p in targets if not page_path(book_dir, p).exists()]
    total = len(targets)
    text_prompt = prompt(row["writing_mode"])
    set_progress(work_id, 0, total, "transcribe")
    try:
        for n, idx in enumerate(targets):
            if cancel_check and cancel_check():
                raise Cancelled()
            raw, _ = archive.read_page(archive_path, idx)
            out = llm.chat(
                base_url,
                [llm.image_message(text_prompt, _data_url(raw))],
                temperature=0.0,
                think=False,
            )
            _write(page_path(book_dir, idx), clean_output(out))
            set_progress(work_id, n + 1, total, "transcribe")
    finally:
        clear_progress(work_id)
    return total
