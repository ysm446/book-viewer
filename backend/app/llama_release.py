"""llama.cpp の公式リリース(Windows ビルド)の取得・ダウンロード・展開。

設定画面から最新ビルドを取得して vendor/llama_cpp/versions/ に展開する。
CUDA ビルドはランタイム(cudart)が別 zip のため、対応する版を同時に展開する。
"""

from __future__ import annotations

import json
import re
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from .llm_server import VENDOR_DIR, find_server_binary

_API_LATEST = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
# ダウンロードを許可するURLの接頭辞(供給元の固定)。
_ALLOWED_PREFIXES = (
    "https://github.com/ggml-org/llama.cpp/releases/download/",
    "https://objects.githubusercontent.com/",
)

_VERSIONS_DIR = VENDOR_DIR / "versions"


def _http_json(url: str, timeout: float = 20.0) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "book-viewer"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def _label(name: str) -> tuple[str, str]:
    """資産名から (kind, 表示ラベル) を作る。"""
    low = name.lower()
    cuda = re.search(r"cuda-([\d.]+)", low)
    if "cpu" in low:
        return ("cpu", "CPU")
    if cuda:
        return ("cuda", f"CUDA {cuda.group(1)}")
    if "vulkan" in low:
        return ("vulkan", "Vulkan (GPU汎用)")
    if "hip" in low or "radeon" in low:
        return ("hip", "HIP/ROCm (AMD)")
    if "sycl" in low:
        return ("sycl", "SYCL (Intel)")
    return ("other", name)


def list_latest() -> dict:
    """最新リリースの Windows x64 ビルド一覧を返す(CUDA は cudart を対応付け)。"""
    d = _http_json(_API_LATEST)
    assets = d.get("assets", [])
    # cudart を cuda バージョンで引けるように索引化。
    cudart: dict[str, dict] = {}
    for a in assets:
        n = a["name"].lower()
        if n.startswith("cudart-") and n.endswith(".zip"):
            m = re.search(r"cuda-([\d.]+)", n)
            if m:
                cudart[m.group(1)] = a

    builds = []
    for a in assets:
        n = a["name"]
        low = n.lower()
        if not low.endswith(".zip") or "win" not in low or low.startswith("cudart-"):
            continue
        if "arm64" in low:
            continue
        if "x64" not in low:
            continue
        kind, label = _label(n)
        cudart_url = None
        cm = re.search(r"cuda-([\d.]+)", low)
        if kind == "cuda" and cm and cm.group(1) in cudart:
            cudart_url = cudart[cm.group(1)]["browser_download_url"]
        builds.append(
            {
                "name": n,
                "label": label,
                "kind": kind,
                "url": a["browser_download_url"],
                "size": a["size"],
                "cudart_url": cudart_url,
            }
        )
    builds.sort(key=lambda b: (b["kind"] != "cpu", b["kind"] != "cuda", b["label"]))
    return {"tag": d.get("tag_name", ""), "builds": builds}


def installed_builds() -> dict:
    """展開済みビルドと、現在自動検出される実行ファイルを返す。"""
    out = []
    if _VERSIONS_DIR.is_dir():
        for sub in sorted(_VERSIONS_DIR.iterdir()):
            if not sub.is_dir():
                continue
            exe = None
            for name in ("llama-server.exe", "llama-server"):
                found = next(sub.rglob(name), None)
                if found:
                    exe = str(found)
                    break
            if exe:
                out.append({"name": sub.name, "server_path": exe})
    return {"installed": out, "auto_detected": find_server_binary(None)}


def _download_zip(url: str, dest_dir: Path) -> None:
    if not url.startswith(_ALLOWED_PREFIXES):
        raise ValueError(f"許可されていないダウンロード元です: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "book-viewer"})
    # 数百 MB になり得るので、メモリに読み込まず一時ファイル経由で展開する。
    with tempfile.TemporaryFile() as tmp:
        with urllib.request.urlopen(req, timeout=600) as res:
            shutil.copyfileobj(res, tmp)
        tmp.seek(0)
        with zipfile.ZipFile(tmp) as zf:
            zf.extractall(dest_dir)


def download_build(url: str, name: str, cudart_url: str | None = None) -> dict:
    """ビルド zip(必要なら cudart も)を versions/<name> へ展開し、server パスを返す。"""
    folder = re.sub(r"\.zip$", "", name, flags=re.IGNORECASE)
    # フォルダ名はリリース資産名由来のみを許可し、versions/ 外への書き込みを防ぐ。
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", folder):
        raise ValueError(f"不正なビルド名です: {name}")
    target = _VERSIONS_DIR / folder
    target.mkdir(parents=True, exist_ok=True)

    _download_zip(url, target)
    if cudart_url:
        _download_zip(cudart_url, target)

    exe = next(target.rglob("llama-server.exe"), None) or next(
        target.rglob("llama-server"), None
    )
    if not exe:
        raise RuntimeError("展開後に llama-server が見つかりませんでした。")
    return {"name": folder, "server_path": str(exe)}
