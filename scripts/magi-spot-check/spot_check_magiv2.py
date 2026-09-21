"""Magiv2 スポット検証: 手持ちの漫画 zip から数ページを抜き、検出結果を目視確認する。

docs/manga-relationship-graph-notes.md §8 の検証手順に対応する。確認するのは3点:
  1. パネル / キャラクターの bbox が正しく取れているか
  2. キャラクターのクラスタが人物ごとに分かれているか
  3. 吹き出しのしっぽから話者が当たっているか
(OCR は英語学習のため化けて当然。無視する)

使い方:
  python spot_check_magiv2.py <作品zip> [--start 0] [--count 10] [--out out]
                              [--bank <キャラ画像フォルダ>] [--cpu]

  --bank には「名前.png」形式のキャラ代表画像を置いたフォルダを渡せる(任意)。
  無しでも検出とクラスタリングの確認はできる(人物名は自動ラベルになる)。

出力(--out 以下):
  page_XXX_annotated.png  … bbox とクラスタを重畳した画像
  transcript.txt          … <キャラ名>: セリフ 形式の台本
  results.json            … 生の予測結果

初回はモデル(数GB)を Hugging Face からダウンロードする。GPU を使う場合は
先にアプリ側の llama-server をアンロードして VRAM を空けておくこと。
"""

from __future__ import annotations

import argparse
import io
import json
import re
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def natural_key(s: str) -> list:
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def load_pages_from_zip(zip_path: Path, start: int, count: int) -> list[np.ndarray]:
    """zip 内の画像を名前順に並べ、start から count ページを連続で取り出す。

    話者同定・クラスタ一貫性の確認には、飛び飛びより連続ページが適する。
    """
    pages: list[np.ndarray] = []
    with zipfile.ZipFile(zip_path) as zf:
        names = sorted(
            (n for n in zf.namelist() if Path(n).suffix.lower() in IMAGE_EXTS),
            key=natural_key,
        )
        for name in names[start : start + count]:
            with zf.open(name) as f:
                img = Image.open(io.BytesIO(f.read())).convert("L").convert("RGB")
            pages.append(np.array(img))
    return pages


def load_character_bank(bank_dir: Path | None) -> dict:
    images: list[np.ndarray] = []
    names: list[str] = []
    if bank_dir and bank_dir.is_dir():
        for p in sorted(bank_dir.iterdir()):
            if p.suffix.lower() in IMAGE_EXTS:
                images.append(np.array(Image.open(p).convert("L").convert("RGB")))
                names.append(p.stem)
    return {"images": images, "names": names}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("zip", type=Path, help="連番画像入りの作品 zip")
    ap.add_argument("--start", type=int, default=0, help="開始ページ index(0 始まり)")
    ap.add_argument("--count", type=int, default=10, help="検証ページ数")
    ap.add_argument("--out", type=Path, default=Path("out"), help="出力フォルダ")
    ap.add_argument("--bank", type=Path, default=None, help="キャラ代表画像フォルダ(名前.png)")
    ap.add_argument("--cpu", action="store_true", help="GPU を使わない(遅いが VRAM 不要)")
    args = ap.parse_args()

    import torch
    from transformers import AutoModel

    device = "cpu" if args.cpu or not torch.cuda.is_available() else "cuda"
    print(f"device: {device} / モデルをロード中(初回はダウンロードあり)…")
    model = AutoModel.from_pretrained("ragavsachdeva/magiv2", trust_remote_code=True)
    model = model.to(device).eval()

    pages = load_pages_from_zip(args.zip, args.start, args.count)
    if not pages:
        raise SystemExit("zip から画像を取り出せませんでした")
    bank = load_character_bank(args.bank)
    print(f"pages: {len(pages)} / character bank: {len(bank['names'])} 人")

    with torch.no_grad():
        per_page = model.do_chapter_wide_prediction(
            pages, bank, use_tqdm=True, do_ocr=True
        )

    args.out.mkdir(parents=True, exist_ok=True)
    transcript: list[str] = []
    for i, (image, result) in enumerate(zip(pages, per_page)):
        out_png = args.out / f"page_{args.start + i:03d}_annotated.png"
        model.visualise_single_image_prediction(image, result, filename=str(out_png))
        # テキスト j → 話者キャラ index の対応から <名前>: セリフ の台本を作る。
        speaker = {
            t: result["character_names"][c]
            for t, c in result.get("text_character_associations", [])
        }
        essential = result.get("is_essential_text") or []
        for j, text in enumerate(result.get("ocr", [])):
            if j < len(essential) and not essential[j]:
                continue  # 看板・効果音など台詞でないテキスト
            transcript.append(f"<{speaker.get(j, '?')}>: {text}")

    (args.out / "transcript.txt").write_text("\n".join(transcript), encoding="utf-8")

    def _default(o):  # numpy 型を JSON 化できる形に落とす
        if isinstance(o, np.ndarray):
            return o.tolist()
        if isinstance(o, (np.integer, np.floating)):
            return o.item()
        return str(o)

    (args.out / "results.json").write_text(
        json.dumps(per_page, ensure_ascii=False, indent=2, default=_default),
        encoding="utf-8",
    )
    print(f"完了: {args.out} の page_*_annotated.png を目視確認してください")


if __name__ == "__main__":
    main()
