"""ページ画像からのセリフ・テキスト抽出(OCR)。

mokuro(comic-text-detector によるテキスト領域検出 + manga-ocr による読み取り)を使う。
縦書き・ルビ・吹き出し外のモノローグに対応し、汎用 OCR より漫画での精度が大きく高い。

- 依存は requirements-ocr.txt(任意インストール)。未導入ならロードに失敗し、
  以後は常に None を返す(解析は OCR なしで従来通り続行する)。
- モデルの重みは初回使用時に自動ダウンロードされる(comic-text-detector + manga-ocr)。
- CUDA が使える torch なら GPU、無ければ CPU で動く(mokuro が自動選択)。
  VRAM 使用は実測 1.1GB 程度で、llama-server と同居できる。
"""

from __future__ import annotations

import io
import threading
from importlib.util import find_spec

_lock = threading.Lock()
_mpocr = None  # ロード済み MangaPageOcr(シングルトン)
_failed = False  # ロード失敗。以後の呼び出しは黙ってスキップする。


def available() -> bool:
    """mokuro が import 可能か(モデルのロードはしない)。"""
    return find_spec("mokuro") is not None


def _get():
    """MangaPageOcr を遅延ロードして返す(失敗時 None)。"""
    global _mpocr, _failed
    with _lock:
        if _mpocr is not None or _failed:
            return _mpocr
        try:
            from mokuro.manga_page_ocr import MangaPageOcr

            _mpocr = MangaPageOcr(force_cpu=False)
        except Exception:  # noqa: BLE001 - 未導入/重みDL失敗いずれでも解析本体は続行させる
            _failed = True
        return _mpocr


def _sort_blocks(blocks: list[dict], img_height: int) -> list[dict]:
    """テキストブロックを漫画の読み順(上→下、同じ高さ帯は右→左)に近づける粗いソート。"""
    band = max(1, img_height // 4)

    def key(blk: dict) -> tuple[int, float]:
        x0, y0, x1, _y1 = blk.get("box", [0, 0, 0, 0])[:4]
        return (int(y0) // band, -float(x1))

    return sorted(blocks, key=key)


def extract_text(image_bytes: bytes) -> str | None:
    """ページ画像(エンコード済みバイト列)からテキストを抽出する。

    戻り値はブロックごとに改行で区切った文字列。OCR 不可(未導入・失敗)や
    テキストが見つからない場合は None。
    """
    mpocr = _get()
    if mpocr is None:
        return None
    try:
        result = mpocr(io.BytesIO(image_bytes))
    except Exception:  # noqa: BLE001 - 1ページの OCR 失敗で解析全体を止めない
        return None
    blocks = _sort_blocks(result.get("blocks") or [], int(result.get("img_height") or 0))
    texts: list[str] = []
    for blk in blocks:
        # 縦書きの1ブロックは行を連結して1つのセリフにする(日本語は空白不要)。
        t = "".join(line.strip() for line in (blk.get("lines") or [])).strip()
        if t:
            texts.append(t)
    return "\n".join(texts) or None
