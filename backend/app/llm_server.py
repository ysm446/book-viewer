"""llama-server(ローカル LLM)のプロセス管理とモデル走査。

GPU なし環境も想定し、必要なときだけ手動でロード/アンロードする。
設定で指定したフォルダ(未指定なら models/)の GGUF を走査し、選んだモデルで
llama-server を起動する。
"""

from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

from . import llm

# プロジェクト直下のフォルダ(dev 想定)。
_ROOT = Path(__file__).resolve().parents[2]
MODELS_DIR = _ROOT / "models"
VENDOR_DIR = _ROOT / "vendor" / "llama_cpp"
LOG_PATH = _ROOT / "data" / "llama-server.log"


def _read_log_tail(n: int = 800) -> str:
    try:
        return LOG_PATH.read_text(encoding="utf-8", errors="replace")[-n:].strip()
    except OSError:
        return ""


def resolve_models_dir(explicit: str | None = None) -> Path:
    """モデル置き場を解決する(設定の明示パス → 既定の models/)。

    空文字・空白のみは「未指定」とみなす。存在しないパスでも解決結果として返し、
    走査側で空一覧にする(UI にパスを見せて誤りに気づけるようにするため)。
    """
    if explicit and explicit.strip():
        return Path(explicit.strip()).expanduser()
    return MODELS_DIR


def scan_models(models_dir: Path | None = None) -> list[dict]:
    """モデル置き場の GGUF(本体)を走査する。mmproj は除外し、兄弟にあれば対応付ける。"""
    d = models_dir or MODELS_DIR
    if not d.is_dir():
        return []
    out: list[dict] = []
    for gguf in sorted(d.rglob("*.gguf")):
        # mmproj(画像入力用の付属)と埋め込みモデル(本文検索用。embedding.py が使う)は会話に使えない。
        if "mmproj" in gguf.name.lower() or "embed" in gguf.name.lower():
            continue
        mmproj = None
        for cand in gguf.parent.glob("*.gguf"):
            if "mmproj" in cand.name.lower():
                mmproj = str(cand)
                break
        out.append(
            {
                "name": gguf.stem,
                "path": str(gguf),
                "mmproj": mmproj,
                "dir": gguf.parent.name,
                "size": gguf.stat().st_size,
                "vision": mmproj is not None,
            }
        )
    return out


def _auto_ngl(binary_path: str) -> int:
    """実行ファイル(ビルド)の種別から GPU オフロード数を自動決定する。

    GPU ビルド(cuda/vulkan/hip/sycl)なら全レイヤーを GPU へ(999)。
    llama.cpp 側の自動フィットで VRAM に収まる分だけ載る。CPU ビルドは 0。
    """
    # フルパス全体で見ると途中のフォルダ名(C:\\Users\\chipper など)に引っかかるので、
    # 実行ファイル名と展開フォルダ名(llama-b1234-bin-win-cuda-x64 など)だけで判定する。
    path = Path(binary_path)
    p = f"{path.parent.name}/{path.name}".lower()
    if "cpu" in p:
        return 0
    if any(k in p for k in ("cuda", "vulkan", "hip", "rocm", "radeon", "sycl")):
        return 999
    return 0


def find_server_binary(explicit: str | None) -> str | None:
    """llama-server の実行ファイルを解決する(明示パス → vendor 自動検出)。"""
    if explicit:
        p = Path(explicit)
        if p.is_file():
            return str(p)
    if VENDOR_DIR.is_dir():
        for name in ("llama-server.exe", "llama-server"):
            for found in VENDOR_DIR.rglob(name):
                return str(found)
    return None


class _State:
    proc: subprocess.Popen | None = None
    model_name: str | None = None
    base_url: str | None = None
    ctx_size: int | None = None  # 起動時のコンテキスト長(本文をどれだけ一度に渡せるかの目安)
    log = None  # type: ignore[assignment]


_state = _State()

# load/stop はエンドポイントから並行に呼ばれ得る(uvicorn のスレッドプール)。
# 排他しないと二重ロードで片方のプロセスが参照を失いポートを掴んだまま残る。
# load() 内部から stop() を呼ぶため再入可能ロックにする。
_lock = threading.RLock()
# load() どうしを直列にするロック(状態のロックとは別。待ちの間に status() を止めない)。
_load_lock = threading.Lock()
_loading = False


def status() -> dict:
    with _lock:
        running = _state.proc is not None and _state.proc.poll() is None
        if not running and _state.proc is not None:
            # 勝手に落ちていたら状態を片付ける(ログのハンドルも閉じる)。
            _state.proc = None
            _state.model_name = None
            _state.base_url = None
            if _state.log is not None:
                try:
                    _state.log.close()
                except OSError:
                    pass
                _state.log = None
        return {
            "running": running,
            "loading": _loading,
            "model": _state.model_name,
            "base_url": _state.base_url,
            "ctx_size": _state.ctx_size if running else None,
        }


def _parse_host_port(base_url: str) -> tuple[str, int]:
    u = urlparse(base_url)
    return (u.hostname or "127.0.0.1", u.port or 8080)


def load(
    server_path: str,
    model_path: str,
    mmproj_path: str | None,
    ctx_size: int,
    base_url: str,
    timeout: float = 180.0,
) -> dict:
    """選んだモデルで llama-server を起動する(既存があれば停止してから)。

    GPU オフロード数(-ngl)はビルド種別から自動決定する。
    """
    # 起動確認の待ち(最大 timeout 秒)の間も status() が即座に返るよう、状態のロックは
    # 短く持ち、load どうしの直列化は別のロックで行う。
    global _loading
    with _load_lock:
        _loading = True
        try:
            return _load(server_path, model_path, mmproj_path, base_url, ctx_size, timeout)
        finally:
            _loading = False


def _load(
    server_path: str | None,
    model_path: str,
    mmproj_path: str | None,
    base_url: str,
    ctx_size: int,
    timeout: float,
) -> dict:
    with _lock:
        stop()
        binary = find_server_binary(server_path)
        if not binary:
            raise FileNotFoundError(
                "llama-server の実行ファイルが見つかりません。設定でパスを指定するか "
                "vendor/llama_cpp/ に配置してください。"
            )
        if not Path(model_path).is_file():
            raise FileNotFoundError(f"モデルが見つかりません: {model_path}")

        ngl = _auto_ngl(binary)
        host, port = _parse_host_port(base_url)

        # 既にそのポートで応答がある場合はバインドできないので明示エラー。
        if llm.ping(base_url):
            raise RuntimeError(
                f"ポート {port} は既に使用中です。別の llama-server が起動中の可能性があります。"
                "アンロードするか、設定でポートを変えてください。"
            )

        args = [
            binary,
            "-m",
            model_path,
            "--host",
            host,
            "--port",
            str(port),
            "-c",
            str(ctx_size),
            "-ngl",
            str(ngl),
            # 思考(reasoning/thinking)モードをオフにする。
            "--reasoning",
            "off",
        ]
        if mmproj_path:
            args += ["--mmproj", mmproj_path]

        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        _state.log = open(LOG_PATH, "w", encoding="utf-8", errors="replace")
        try:
            _state.proc = subprocess.Popen(args, stdout=_state.log, stderr=subprocess.STDOUT)
        except OSError:
            # 起動できなかったらログのハンドルを残さない(壊れた exe 指定等)。
            _state.log.close()
            _state.log = None
            raise
        _state.model_name = Path(model_path).stem
        _state.base_url = base_url
        _state.ctx_size = ctx_size
        proc = _state.proc

    deadline = time.time() + timeout
    while time.time() < deadline:
        with _lock:
            if _state.proc is not proc:
                raise RuntimeError("読み込み中に別の操作で llama-server が停止しました。")
            if proc.poll() is not None:
                stop()
                tail = _read_log_tail()
                detail = f"\n--- llama-server の出力 ---\n{tail}" if tail else ""
                raise RuntimeError(
                    "llama-server が起動直後に終了しました。引数やモデル、実行ファイルのビルド"
                    "(CUDA/CPU など)を確認してください。" + detail
                )
        if llm.ping(base_url):
            return status()
        time.sleep(0.5)
    stop()
    tail = _read_log_tail()
    raise TimeoutError(
        "llama-server の起動確認がタイムアウトしました。"
        + (f"\n--- llama-server の出力 ---\n{tail}" if tail else "")
    )


def stop() -> dict:
    with _lock:
        if _state.proc is not None:
            try:
                _state.proc.terminate()
                try:
                    _state.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    _state.proc.kill()
            except OSError:
                pass
        _state.proc = None
        _state.model_name = None
        _state.base_url = None
        if _state.log is not None:
            try:
                _state.log.close()
            except OSError:
                pass
            _state.log = None
        return status()
