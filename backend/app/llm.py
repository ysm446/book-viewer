"""OpenAI 互換エンドポイント(llama-server 等)への薄いクライアント。

llama-server を `--mmproj` 付きで起動すると、/v1/chat/completions に
画像(image_url の data URL)を渡すマルチモーダル推論ができる。
ここでは追加依存を避け、標準ライブラリ(urllib)で呼ぶ。
"""

from __future__ import annotations

import http.client
import json
import re
import urllib.error
import urllib.request


class LlmError(RuntimeError):
    pass


class LlmHttpError(LlmError):
    """LLM サーバが HTTP エラーを返した(status を持つ)。"""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


# urlopen は接続時の失敗を URLError に包むが、読み出し中の切断・タイムアウトは素の例外で出る。
_NETWORK_ERRORS = (urllib.error.URLError, OSError, http.client.HTTPException)


def _iter_lines(resp):
    """ストリーム応答を行ごとに返す。途中でサーバが落ちたら LlmError にする。"""
    try:
        yield from resp
    except _NETWORK_ERRORS as e:
        raise LlmError(f"LLM サーバとの通信が途中で切れました: {e}") from e


_THINK_RE = re.compile(r"<(think|thinking|reasoning)>.*?</\1>", re.DOTALL | re.IGNORECASE)


def strip_think(text: str) -> str:
    """モデルの思考ブロック(<think>...</think> 等)を取り除く。

    除去後に空になる場合は、タグ記号だけ消した元テキストを返す(情報を失わない)。
    """
    stripped = _THINK_RE.sub("", text).strip()
    if stripped:
        return stripped
    return re.sub(r"</?(think|thinking|reasoning)>", "", text, flags=re.IGNORECASE).strip()


def _post(url: str, payload: dict, timeout: float) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:500]
        raise LlmHttpError(e.code, f"LLM サーバがエラーを返しました({e.code}): {body}") from e
    except _NETWORK_ERRORS as e:
        # 接続失敗だけでなく、読み出し中のタイムアウト・切断(サーバが落ちた等)も同じ扱いにする。
        raise LlmError(f"LLM サーバへ接続できません: {e}") from e


def _payload(
    model: str,
    messages: list[dict],
    temperature: float,
    stream: bool,
    think: bool | None,
    json_mode: bool = False,
    json_schema: dict | None = None,
) -> dict:
    payload: dict = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": stream,
    }
    # 思考(reasoning)対応モデル向けに chat テンプレートへ enable_thinking を渡す。
    # think=None のときは何も指定しない(従来動作を保つ)。
    if think is not None:
        payload["chat_template_kwargs"] = {"enable_thinking": bool(think)}
    # llama-server は response_format による constrained decoding に対応。
    # json_schema はスキーマ準拠まで、json_object は「有効な JSON」までをデコード時に保証する。
    if json_schema is not None:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "result", "schema": json_schema},
        }
    elif json_mode:
        payload["response_format"] = {"type": "json_object"}
    return payload


def chat(
    base_url: str,
    messages: list[dict],
    model: str = "local",
    timeout: float = 600.0,
    temperature: float = 0.2,
    think: bool | None = None,
    json_mode: bool = False,
    json_schema: dict | None = None,
) -> str:
    """chat completions を呼び、最初の選択肢の本文を返す。

    base_url 例: http://127.0.0.1:8080/v1
    json_schema でスキーマ準拠を、json_mode=True で JSON であることを、デコード時に強制する。
    json_schema 未対応のサーバでは自動的に json_object へ落として再試行する。
    """
    url = base_url.rstrip("/") + "/chat/completions"
    try:
        res = _post(
            url, _payload(model, messages, temperature, False, think, json_mode, json_schema), timeout
        )
    except LlmHttpError as e:
        # 古い llama-server 等が response_format(json_schema) を拒否した場合の後方互換。
        # 接続失敗やタイムアウトで同じ呼び出しを繰り返さないよう、400 のときだけ落とす。
        if json_schema is None or e.status != 400:
            raise
        res = _post(url, _payload(model, messages, temperature, False, think, True), timeout)
    try:
        content = res["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise LlmError(f"LLM 応答の形式が不正です: {res!r}") from e
    return strip_think(content or "")


def chat_stream(
    base_url: str,
    messages: list[dict],
    model: str = "local",
    timeout: float = 600.0,
    temperature: float = 0.2,
    think: bool | None = None,
):
    """chat completions を stream=True で呼び、差分(delta)を順に yield する。

    yield する dict は {"type": "reasoning"|"content", "text": str}。
    reasoning は思考過程(対応モデルが reasoning_content を返す場合)。
    """
    url = base_url.rstrip("/") + "/chat/completions"
    data = json.dumps(_payload(model, messages, temperature, True, think)).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
    except _NETWORK_ERRORS as e:
        raise LlmError(f"LLM サーバへ接続できません: {e}") from e
    with resp:
        for raw in _iter_lines(resp):
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            body = line[len("data:") :].strip()
            if body == "[DONE]":
                break
            try:
                delta = json.loads(body)["choices"][0]["delta"]
            except (json.JSONDecodeError, KeyError, IndexError, TypeError):
                continue
            rc = delta.get("reasoning_content")
            if rc:
                yield {"type": "reasoning", "text": rc}
            c = delta.get("content")
            if c:
                yield {"type": "content", "text": c}


def parse_json(text: str) -> dict:
    """モデル出力から最初の JSON オブジェクトを取り出す(コードフェンス許容)。"""
    cleaned = text.strip()
    cleaned = re.sub(r"^```[a-zA-Z]*", "", cleaned).strip()
    cleaned = cleaned.rstrip("`").strip()
    m = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    return {}


def ping(base_url: str, timeout: float = 5.0) -> bool:
    """/models を叩いて到達性を確認する。"""
    url = base_url.rstrip("/") + "/models"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status == 200
    except _NETWORK_ERRORS:
        return False


def image_message(text: str, data_url: str) -> dict:
    """テキスト + 画像1枚のユーザーメッセージを作る。"""
    return {
        "role": "user",
        "content": [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": data_url}},
        ],
    }
