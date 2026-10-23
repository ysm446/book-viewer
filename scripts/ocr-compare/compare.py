"""文字起こしエンジンの比較(M1)。

同じページ画像を複数のエンジンで文字起こしし、正解テキストとの文字誤り率(CER)と
1 ページあたりの時間を出す。

    backend/.venv/Scripts/python.exe scripts/ocr-compare/compare.py run --engines yomitoku ndlocr
    backend/.venv/Scripts/python.exe scripts/ocr-compare/compare.py run --engines vlm \
        --vlm-model path/to/model.gguf --vlm-mmproj path/to/mmproj.gguf
    backend/.venv/Scripts/python.exe scripts/ocr-compare/compare.py score

作業フォルダは data/ocr-compare/(git 管理外。本の本文を含むため)。--work で別のフォルダにできる
(洋書の比較は data/ocr-compare-en/)。
- pages.json   対象ページ [{"id", "zip", "index", "writing_mode", "lang"?}]
  lang が "en" のページは、文字誤り率に加えて単語誤り率(WER)も出す(英語は語の区切りも大事なため)
- gold/<id>.txt 正解(本文と見出しだけ。書名バー・ページ表示・ルビ・図のキャプションと図の中の文字は
  含めない。キャプションを出力したエンジンは、位置に関係なくその文字数ぶん挿入として数えられる)
- images/<id>.png、out/<engine>/<id>.md、out/<engine>/_time.json は自動生成
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))

WORK = REPO / "data" / "ocr-compare"
NDLOCR_DIR = REPO / "vendor" / "ndlocr-lite"
LLAMA_SERVER = next(
    iter(sorted((REPO / "vendor" / "llama_cpp" / "versions").glob("*cuda*/llama-server.exe"))), None
)
VLM_URL = "http://127.0.0.1:8090/v1"


def load_pages() -> list[dict]:
    return json.loads((WORK / "pages.json").read_text(encoding="utf-8"))


def extract_images(pages: list[dict]) -> None:
    from app import archive

    out = WORK / "images"
    out.mkdir(parents=True, exist_ok=True)
    for p in pages:
        dst = out / f"{p['id']}.png"
        if not dst.exists():
            data, _ = archive.read_page(Path(p["zip"]), p["index"])
            dst.write_bytes(data)


def _save(engine: str, results: dict[str, str], times: dict[str, float]) -> None:
    d = WORK / "out" / engine
    d.mkdir(parents=True, exist_ok=True)
    for pid, text in results.items():
        (d / f"{pid}.md").write_text(text, encoding="utf-8")
    (d / "_time.json").write_text(json.dumps(times, indent=2), encoding="utf-8")


def run_vlm(pages: list[dict], model: str, mmproj: str) -> None:
    from app import llm, llm_server, transcribe

    llm_server.load(str(LLAMA_SERVER), model, mmproj, 16384, VLM_URL, timeout=600)
    results, times = {}, {}
    try:
        for p in pages:
            raw = (WORK / "images" / f"{p['id']}.png").read_bytes()
            t = time.time()
            out = llm.chat(
                VLM_URL,
                [llm.image_message(transcribe.prompt(p["writing_mode"], p.get("lang", "ja")), transcribe._data_url(raw))],
                temperature=0.0,
                think=False,
            )
            times[p["id"]] = time.time() - t
            results[p["id"]] = transcribe.clean_output(out)
            print("vlm", p["id"], round(times[p["id"]], 1), flush=True)
    finally:
        llm_server.stop()
    _save("vlm-" + Path(model).stem, results, times)


def run_yomitoku(pages: list[dict]) -> None:
    import cv2
    from yomitoku import DocumentAnalyzer

    # 書名バー・ページ表示(ヘッダー/フッター)とルビは本文に含めない。
    analyzer = DocumentAnalyzer(device="cuda", ignore_meta=True, ignore_ruby=True)
    results, times = {}, {}
    tmp = WORK / "out" / "yomitoku" / "_tmp.md"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    for p in pages:
        img = cv2.imread(str(WORK / "images" / f"{p['id']}.png"))
        t = time.time()
        res, _, _ = analyzer(img)
        md = res.to_markdown(str(tmp), ignore_line_break=True, img=img, export_figure=False)
        times[p["id"]] = time.time() - t
        results[p["id"]] = md
        print("yomitoku", p["id"], round(times[p["id"]], 2), flush=True)
    tmp.unlink(missing_ok=True)
    _save("yomitoku", results, times)


def run_bookviewer(pages: list[dict]) -> None:
    """アプリ本体の変換(YomiToku → 段落の分け直し・キャプション判定 → Markdown)。"""
    from app import layout_ocr

    results, times = {}, {}
    for p in pages:
        raw = (WORK / "images" / f"{p['id']}.png").read_bytes()
        t = time.time()
        md, *_ = layout_ocr.transcribe(raw, p.get("lang", "ja"))
        times[p["id"]] = time.time() - t
        results[p["id"]] = md
        print("bookviewer", p["id"], round(times[p["id"]], 2), flush=True)
    _save("bookviewer", results, times)


def run_ndlocr(pages: list[dict]) -> None:
    out = WORK / "out" / "ndlocr"
    out.mkdir(parents=True, exist_ok=True)
    py = NDLOCR_DIR / ".venv" / "Scripts" / "python.exe"
    results, times = {}, {}
    for p in pages:
        img = WORK / "images" / f"{p['id']}.png"
        t = time.time()
        subprocess.run(
            [str(py), "ocr.py", "--sourceimg", str(img), "--output", str(out)],
            cwd=NDLOCR_DIR / "src",
            check=True,
            capture_output=True,
        )
        # モデルの読み込みを含む。ページあたりの純粋な処理時間はログの値の方が近い。
        times[p["id"]] = time.time() - t
        results[p["id"]] = (out / f"{p['id']}.txt").read_text(encoding="utf-8")
        print("ndlocr", p["id"], round(times[p["id"]], 2), flush=True)
    _save("ndlocr", results, times)


# ---- 採点 ----

_FIG_RE = re.compile(r"\[図[:：]\s*")
_MD_RE = re.compile(r"<br\s*/?>|<[^>]+>|\\(?=\S)|[#*`|>]")


def normalize(text: str) -> str:
    """表記ゆれ(全角半角・Markdown 記号・空白)を除いて文字だけを比べる。"""
    text = unicodedata.normalize("NFKC", text)
    # 図の参照 ![キャプション](パス) はキャプションだけ残す
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    # ルビは本文に含めない(<rt> の中身ごと落とす)
    text = re.sub(r"<rt>.*?</rt>", "", text)
    text = _FIG_RE.sub("", text)
    text = _MD_RE.sub("", text)
    text = text.replace("]", "").replace("[", "")
    # 波ダッシュ・ハイフン類は揃える(フォントで見分けられないため)
    text = re.sub(r"[〜~～‐―—−–-]", "-", text)
    return re.sub(r"\s+", "", text)


def normalize_en(text: str) -> str:
    """英語のページの文字の比較用。大文字小文字(スモールキャピタルは見分けにくい)とハイフンを無視する。

    行末のハイフンで切れた語(some-thing)と、本来のハイフン(fat-bellied)は画像だけでは区別できないため、
    ハイフンは除いて比べる。ダッシュは語の区切りとして空白にする。
    """
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    # VLM の図の説明([図: A photograph of …])は本文ではないので比べない
    text = re.sub(r"\[図[:：][^\]]*\]", " ", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"[‘’`]", "'", text)
    text = re.sub(r"[“”]", '"', text)
    text = re.sub(r"[―—–]", " ", text)
    text = re.sub(r"[‐−-]", "", text)
    # 見出しの記号・強調・場面転換の飾り(* * * など)は比べない
    text = re.sub(r"[#*_\\|>\[\]⁂※米]", " ", text)
    return text.lower()


def words(text: str) -> list[str]:
    """英語の単語の並び(句読点を除く)。単語誤り率(WER)に使う。"""
    tokens = (re.sub(r"[^\w']", "", t).strip("'") for t in normalize_en(text).split())
    return [t for t in tokens if t]


def levenshtein(a, b) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
        prev = cur
    return prev[-1]


def score() -> None:
    pages = load_pages()
    engines = sorted(d.name for d in (WORK / "out").iterdir() if d.is_dir())
    rows = []
    for eng in engines:
        times = json.loads((WORK / "out" / eng / "_time.json").read_text(encoding="utf-8"))
        errs = total = werrs = wtotal = 0
        per = []
        for p in pages:
            gold_file = WORK / "gold" / f"{p['id']}.txt"
            out_file = WORK / "out" / eng / f"{p['id']}.md"
            if not gold_file.exists() or not out_file.exists():
                continue
            gold = gold_file.read_text(encoding="utf-8")
            out = out_file.read_text(encoding="utf-8")
            if p.get("lang") == "en":
                g = re.sub(r"\s+", "", normalize_en(gold))
                o = re.sub(r"\s+", "", normalize_en(out))
            else:
                g = normalize(gold)
                o = normalize(out)
            e = levenshtein(o, g)
            errs += e
            total += len(g)
            item = f"{p['id']}={e / len(g):.1%}"
            if p.get("lang") == "en":
                gw = words(gold)
                we = levenshtein(words(out), gw)
                werrs += we
                wtotal += len(gw)
                item += f"/{we / len(gw):.1%}"
            per.append(item)
        sec = sum(times.values()) / max(1, len(times))
        wer = f"{werrs / wtotal:7.2%}" if wtotal else f"{'-':>7}"
        rows.append((eng, errs / max(1, total), wer, sec, " ".join(per)))
    print(f"{'engine':40} {'CER':>7} {'WER':>7} {'sec/p':>6}  per-page(CER/WER)")
    for eng, cer, wer, sec, per in sorted(rows, key=lambda r: r[1]):
        print(f"{eng:40} {cer:7.2%} {wer} {sec:6.1f}  {per}")


def main() -> None:
    global WORK
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", help="作業フォルダ(既定は data/ocr-compare)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--engines", nargs="+", choices=["vlm", "yomitoku", "ndlocr", "bookviewer"], required=True)
    r.add_argument("--vlm-model")
    r.add_argument("--vlm-mmproj")
    sub.add_parser("score")
    args = ap.parse_args()
    if args.work:
        WORK = Path(args.work).resolve()

    if args.cmd == "score":
        score()
        return
    pages = load_pages()
    extract_images(pages)
    for eng in args.engines:
        if eng == "vlm":
            run_vlm(pages, args.vlm_model, args.vlm_mmproj)
        elif eng == "yomitoku":
            run_yomitoku(pages)
        elif eng == "ndlocr":
            run_ndlocr(pages)
        elif eng == "bookviewer":
            run_bookviewer(pages)


if __name__ == "__main__":
    main()
