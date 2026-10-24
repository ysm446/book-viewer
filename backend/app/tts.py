"""音声読み上げ(TTS): Irodori-TTS-Server の導入・起動・停止と、合成の呼び出し。

設計(docs/design/tts.md):
- エンジンは Irodori-TTS(Aratako、MIT。日本語専用)。公式の OpenAI 互換サーバー
  Irodori-TTS-Server を vendor/irodori-tts-server/ に git clone + `uv sync` で入れ、
  バックエンドから子プロセスとして起動する(llama-server と同じ作法)。
- アプリの .venv には TTS の依存を入れない(torch のバージョンが衝突する)。サーバーは自分の
  .venv(uv が作る。Python もサーバーの指定に合わせて uv が用意する)で動く。
- アプリとサーバーの間は `POST /v1/audio/speech` 1 本。声の指定(キャプション・参照音声・seed)は
  設定の値をそのまま渡す。合成した音声は data/tts-cache/ に置き、同じ文は合成し直さない。
- 設定の URL(既定 http://127.0.0.1:8088)が既に応答していれば(別のアプリが起動したサーバー)それを使い、
  止めない。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx

_ROOT = Path(__file__).resolve().parents[2]
VENDOR_DIR = _ROOT / "vendor" / "irodori-tts-server"
CACHE_DIR = _ROOT / "data" / "tts-cache"
LOG_PATH = _ROOT / "data" / "tts-server.log"
MARKER_NAME = ".book-viewer-install.json"

REPO = "https://github.com/Aratako/Irodori-TTS-Server.git"
MODEL_NAME = "irodori-tts"
DEFAULT_BASE_URL = "http://127.0.0.1:8088"
# この PC の TTS モデル置き場(ユーザー指定 2026-10-24。llm / diffusion と並べる)。設定で上書きできる。
# 無い環境では空 = Hugging Face の既定のキャッシュ(~/.cache/huggingface)を使う。
DEFAULT_MODELS_DIR = r"D:\ai-models\tts"
# 初回の起動はモデル(約 3.4 GB)の取得を含むので長く待つ。2 回目以降は 20 秒前後。
STARTUP_TIMEOUT = 900.0
# 合成 1 回の上限(長い段落は中で分けて合成するので、本文の長さに比例して伸びる)。
SYNTH_TIMEOUT = 300.0
# キャッシュの上限(バイト)。超えたら古いものから消す。
CACHE_LIMIT = 400 * 1024 * 1024

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0


class TtsError(RuntimeError):
    pass


# ---- 置き場の解決 ---------------------------------------------------------


def resolve_server_dir(explicit: str | None) -> Path:
    """サーバーのフォルダ(設定の明示パス → 既定の vendor/irodori-tts-server)。"""
    if explicit and explicit.strip():
        return Path(explicit.strip()).expanduser()
    return VENDOR_DIR


def resolve_models_dir(explicit: str | None) -> str:
    """モデル置き場(設定の明示パス → 既定の D:\\ai-models\\tts があればそれ → 空 = HF の既定)。"""
    if explicit and explicit.strip():
        return str(Path(explicit.strip()).expanduser())
    return DEFAULT_MODELS_DIR if Path(DEFAULT_MODELS_DIR).is_dir() else ""


def resolve_base_url(explicit: str | None) -> str:
    return (explicit or "").strip().rstrip("/") or DEFAULT_BASE_URL


def find_uv() -> str | None:
    """uv(PATH → アプリの .venv の Scripts)。"""
    found = shutil.which("uv")
    if found:
        return found
    scripts = Path(sys.executable).parent
    for name in ("uv.exe", "uv"):
        cand = scripts / name
        if cand.exists():
            return str(cand)
    return None


def _read_marker(path: Path) -> dict | None:
    try:
        return json.loads((path / MARKER_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _installed(server_dir: Path) -> bool:
    """導入済みか。自前で入れた目印か、ほかのアプリ(story-graph など)が入れたサーバーでも、
    パッケージと .venv がそろっていれば使える。"""
    if not server_dir.is_dir():
        return False
    if _read_marker(server_dir) is not None:
        return True
    return (server_dir / "pyproject.toml").is_file() and (server_dir / ".venv").is_dir()


# ---- 導入(git clone + uv sync) ---------------------------------------------


class _Install:
    phase: str | None = None  # 'step' / 'done' / 'error'
    label: str = ""
    lines: list[str] = []
    error: str | None = None
    started: float = 0.0


_install = _Install()
_install_lock = threading.Lock()


def _run_logged(cmd: list[str], cwd: Path | None, env: dict[str, str] | None) -> None:
    proc = subprocess.Popen(
        cmd,
        cwd=str(cwd) if cwd else None,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        creationflags=_NO_WINDOW,
    )
    assert proc.stdout is not None
    for raw in iter(proc.stdout.readline, b""):
        text = raw.decode("utf-8", errors="replace").rstrip()
        if text:
            _install.lines = (_install.lines + [text])[-12:]
    proc.wait()
    if proc.returncode != 0:
        raise TtsError(f"{Path(cmd[0]).stem} が失敗しました(exit {proc.returncode}):\n" + "\n".join(_install.lines[-5:]))


def _install_worker(dest: Path) -> None:
    try:
        git = shutil.which("git")
        if git is None:
            raise TtsError("git が見つかりません。Git for Windows をインストールしてから再試行してください。")
        env = {**os.environ, "PYTHONUTF8": "1", "UV_PYTHON_PREFERENCE": "only-managed"}
        if dest.exists():
            _install.label = "以前のインストールを削除しています"
            shutil.rmtree(dest, ignore_errors=True)
            if dest.exists():
                raise TtsError(f"削除できませんでした(サーバーが起動中かもしれません): {dest}")
        uv = find_uv()
        if uv is None:
            _install.label = "uv をインストールしています(アプリの .venv に pip で入れます)"
            _run_logged([sys.executable, "-m", "pip", "install", "uv"], None, env)
            uv = find_uv()
            if uv is None:
                raise TtsError("uv をインストールしましたが見つかりません")
        dest.parent.mkdir(parents=True, exist_ok=True)
        _install.label = f"{REPO} を取得しています"
        _run_logged([git, "clone", "--depth", "1", REPO, str(dest)], None, env)
        # CUDA が使えれば cu128、無ければ CPU のビルドを入れる(torch を含むので数分かかる)。
        extra = "cu128" if _cuda_available() else "cpu"
        _install.label = f"uv sync --extra {extra}(torch を含むため数分かかります)"
        # uv は既定だと PC にある任意の Python(ほかのアプリが同梱しているものまで)を拾う。その Python を
        # 消されると環境ごと壊れるので、uv 自身が取得・管理する Python に限る。
        _run_logged([uv, "sync", "--extra", extra], dest, env)
        marker = {
            "repo": REPO,
            "extra": extra,
            "installed_at": time.strftime("%Y-%m-%d %H:%M"),
        }
        (dest / MARKER_NAME).write_text(json.dumps(marker, ensure_ascii=False), encoding="utf-8")
        _install.phase = "done"
        _install.label = f"インストールしました({round(time.time() - _install.started)} 秒)"
    except Exception as e:  # noqa: BLE001 - 失敗の理由をそのまま状態に残す
        _install.phase = "error"
        _install.error = str(e)
        _install.label = "インストールに失敗しました"


def _cuda_available() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        return False


def install(server_dir: str | None) -> dict:
    """サーバーを(背後で)導入する。進み具合は status() の install で見る。"""
    dest = resolve_server_dir(server_dir)
    with _install_lock:
        if _install.phase == "step":
            raise TtsError("インストールを実行中です")
        if _state.proc is not None and _state.proc.poll() is None:
            raise TtsError("サーバーを停止してからインストールしてください")
        _install.phase = "step"
        _install.label = "準備しています"
        _install.lines = []
        _install.error = None
        _install.started = time.time()
        threading.Thread(target=_install_worker, args=(dest,), daemon=True).start()
    return status(server_dir, None, None)


# ---- サーバーのプロセス -------------------------------------------------------


class _State:
    proc: subprocess.Popen | None = None
    base_url: str | None = None
    starting: bool = False
    error: str | None = None
    log = None  # type: ignore[assignment]


_state = _State()
_lock = threading.RLock()


def _health(base_url: str) -> dict | None:
    """/health の応答(動いていなければ None)。閉じたポートへの接続は短く切る(status は何度も呼ばれる)。"""
    try:
        with httpx.Client(timeout=httpx.Timeout(2.0, connect=0.5)) as client:
            res = client.get(f"{base_url}/health")
            if res.status_code != 200:
                return None
            return res.json()
    except (httpx.HTTPError, OSError, ValueError):
        return None


def _wait_healthy(proc: subprocess.Popen, base_url: str) -> None:
    deadline = time.time() + STARTUP_TIMEOUT
    try:
        while time.time() < deadline:
            if proc.poll() is not None:
                raise TtsError(f"読み上げサーバーが終了しました(exit {proc.returncode})。ログ: {LOG_PATH}")
            if _state.proc is not proc:
                return  # 待っている間に止められた
            h = _health(base_url)
            # IRODORI_PRELOAD で起動時にモデルを読み込む。読み込みが終わるまでは loaded が False。
            if h and h.get("runtime", {}).get("loaded", True):
                return
            time.sleep(1.0)
        raise TtsError(f"読み上げサーバーの起動を {int(STARTUP_TIMEOUT)} 秒待ちましたが応答しません。ログ: {LOG_PATH}")
    except TtsError as e:
        with _lock:
            if _state.proc is proc:
                _state.error = str(e)
                _stop_proc()
    finally:
        with _lock:
            if _state.proc is proc or _state.proc is None:
                _state.starting = False


def start(server_dir: str | None, models_dir: str | None, base_url: str | None) -> dict:
    """サーバーを起動する(待たずに返す。準備ができたかは status() で見る)。"""
    url = resolve_base_url(base_url)
    with _lock:
        if _health(url) is not None or _state.starting:
            return status(server_dir, models_dir, base_url)
        sdir = resolve_server_dir(server_dir)
        if not _installed(sdir):
            raise TtsError("読み上げサーバー(Irodori-TTS-Server)が入っていません。設定 →「読み上げ」からインストールしてください。")
        uv = find_uv()
        if uv is None:
            raise TtsError("uv が見つかりません。設定 →「読み上げ」からインストールし直してください。")
        parts = urlsplit(url)
        host = parts.hostname or "127.0.0.1"
        port = parts.port or 8088
        env = {**os.environ, "PYTHONUTF8": "1", "UV_PYTHON_PREFERENCE": "only-managed", "IRODORI_PRELOAD": "true"}
        mdir = resolve_models_dir(models_dir)
        if mdir:
            env["HF_HOME"] = str(Path(mdir) / "hf-cache")
        cmd = [uv, "run", "--no-sync", "python", "-m", "irodori_openai_tts", "--host", host, "--port", str(port)]
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        _close_log()
        _state.log = open(LOG_PATH, "wb")  # noqa: SIM115 - プロセスの寿命と同じだけ開いておく
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(sdir),
                env=env,
                stdout=_state.log,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                creationflags=_NO_WINDOW,
            )
        except OSError as e:
            _close_log()
            raise TtsError(f"読み上げサーバーを起動できません: {e}") from e
        _state.proc = proc
        _state.base_url = url
        _state.starting = True
        _state.error = None
        threading.Thread(target=_wait_healthy, args=(proc, url), daemon=True).start()
    return status(server_dir, models_dir, base_url)


def _stop_proc() -> None:
    proc = _state.proc
    _state.proc = None
    _state.starting = False
    if proc is not None and proc.poll() is None:
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, check=False)
        except OSError:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    _close_log()


def _close_log() -> None:
    if _state.log is not None:
        try:
            _state.log.close()
        except OSError:
            pass
        _state.log = None


def stop() -> dict:
    """自分で起動したサーバーを止める(別のアプリが起動したものは止めない)。"""
    with _lock:
        _stop_proc()
        _state.error = None
    return status(None, None, _state.base_url)


def status(server_dir: str | None, models_dir: str | None, base_url: str | None) -> dict:
    url = resolve_base_url(base_url)
    sdir = resolve_server_dir(server_dir)
    with _lock:
        spawned = _state.proc is not None and _state.proc.poll() is None
        if _state.proc is not None and not spawned:
            # 自分で起動したプロセスが落ちていた
            if _state.starting:
                _state.error = _state.error or f"読み上げサーバーが終了しました。ログ: {LOG_PATH}"
            _state.proc = None
            _state.starting = False
            _close_log()
        starting = _state.starting
        error = _state.error
    h = _health(url)
    loaded = bool(h and h.get("runtime", {}).get("loaded", True))
    running = h is not None and (loaded or not spawned)
    return {
        "installed": _installed(sdir),
        "server_dir": str(sdir),
        "server_dir_default": str(VENDOR_DIR),
        "models_dir": resolve_models_dir(models_dir),
        "base_url": url,
        "uv": find_uv() is not None,
        # running: 合成できる。starting: 起動・モデルの読み込み中。external: 別のアプリが起動したサーバー
        "running": running,
        "starting": starting or (h is not None and not loaded),
        "external": running and not spawned,
        "checkpoint": (h or {}).get("model", {}).get("hf_checkpoint") if h else None,
        "error": error,
        "log_path": str(LOG_PATH),
        "install": (
            {"phase": _install.phase, "label": _install.label, "lines": _install.lines[-5:], "error": _install.error}
            if _install.phase
            else None
        ),
    }


# ---- 合成 ---------------------------------------------------------------------

# Chromium が再生できる形式。opus は小さい(wav の 1/10)が、サーバー側に ffmpeg か対応する soundfile が要る。
# 失敗したら wav に切り替えて以後 wav で頼む。
_FORMATS = {"opus": "audio/ogg", "wav": "audio/wav"}
_format = "opus"
_format_lock = threading.Lock()


def _voice_body(caption: str, ref_wav: str, seed: int | None) -> dict:
    irodori: dict = {}
    if ref_wav.strip():
        irodori["ref_wavs"] = [ref_wav.strip()]
    else:
        irodori["no_ref"] = True
    if caption.strip():
        irodori["caption"] = caption.strip()
    if seed is not None:
        irodori["seed"] = int(seed)
    return irodori


def _cache_key(text: str, irodori: dict, fmt: str) -> str:
    payload = json.dumps({"text": text, "voice": irodori, "fmt": fmt}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _prune_cache() -> None:
    try:
        files = sorted(CACHE_DIR.iterdir(), key=lambda p: p.stat().st_mtime)
    except OSError:
        return
    total = sum(p.stat().st_size for p in files if p.is_file())
    for p in files:
        if total <= CACHE_LIMIT:
            break
        try:
            size = p.stat().st_size
            p.unlink()
            total -= size
        except OSError:
            pass


def synthesize(
    base_url: str | None, text: str, *, caption: str = "", ref_wav: str = "", seed: int | None = None
) -> tuple[bytes, str]:
    """本文を音声にして (バイト列, media type) を返す。同じ文・同じ声はキャッシュから返す。"""
    global _format
    text = text.strip()
    if not text:
        raise TtsError("読み上げる本文がありません")
    if len(text) > 4000:
        raise TtsError("一度に読み上げられる本文は 4000 字までです")
    url = resolve_base_url(base_url)
    irodori = _voice_body(caption, ref_wav, seed)
    with _format_lock:
        fmt = _format
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached = CACHE_DIR / f"{_cache_key(text, irodori, fmt)}.{fmt}"
    if cached.is_file():
        try:
            os.utime(cached, None)  # 最近使ったものとして残す
            return cached.read_bytes(), _FORMATS[fmt]
        except OSError:
            pass
    body = {"model": MODEL_NAME, "input": text, "response_format": fmt, "irodori": irodori}
    data = _post_speech(url, body)
    if data is None:
        # この形式で出せないサーバー。wav に切り替える
        with _format_lock:
            _format = fmt = "wav"
        body["response_format"] = fmt
        cached = CACHE_DIR / f"{_cache_key(text, irodori, fmt)}.{fmt}"
        data = _post_speech(url, body)
        if data is None:
            raise TtsError("読み上げサーバーが音声を出せませんでした(wav でも失敗)")
    try:
        tmp = cached.with_suffix(cached.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(cached)
        _prune_cache()
    except OSError:
        pass
    return data, _FORMATS[fmt]


def _post_speech(url: str, body: dict) -> bytes | None:
    """`/v1/audio/speech` を呼ぶ。音声の形式に失敗(500 の encode エラー)なら None(呼び出し側で wav に切り替える)。"""
    try:
        with httpx.Client(timeout=httpx.Timeout(SYNTH_TIMEOUT, connect=10.0)) as client:
            res = client.post(f"{url}/v1/audio/speech", json=body)
    except (httpx.HTTPError, OSError) as e:
        raise TtsError(f"読み上げサーバーに接続できません({url}): {e}") from e
    if res.status_code == 200:
        return res.content
    detail = res.text[:500]
    try:
        err = res.json().get("error")
        detail = str(err.get("message") if isinstance(err, dict) else res.json().get("detail") or detail)
    except ValueError:
        pass
    if res.status_code >= 500 and "encode audio" in detail:
        return None
    raise TtsError(f"音声の合成に失敗しました(HTTP {res.status_code}): {detail}")
