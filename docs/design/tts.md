# 音声読み上げ(Irodori-TTS)

作成日時: 2026-10-24 18:30
更新日時: 2026-10-24 18:30

テキスト表示の本文を、ローカルの音声モデルで読み上げる仕組みの設計メモ。2026-10-24 のユーザー発案
(「irodori tts の読み上げを入れられますか？ D:\ai-models」)。story-graph の TTS 連携(`docs/design/voice.md`)と
同じ方式を、本を読む用途に合わせて簡単にしたもの。

## 1. エンジンと配置

- エンジンは [Irodori-TTS](https://github.com/Aratako/Irodori-TTS)(Aratako、MIT。日本語専用。キャプションでの
  声づくりと参照音声のクローンに対応)。チェックポイントは `Aratako/Irodori-TTS-v4-Small`(約 3.4 GB)。
- アプリからは公式の OpenAI 互換サーバー [Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server) を
  使う。**アプリの `.venv` には TTS の依存を入れない**(torch 2.10 系を要求し、YomiToku / Ruri の torch 2.11 と衝突する)。
  サーバーは `vendor/irodori-tts-server/`(git 管理外)に `git clone` + `uv sync --extra cu128`(CUDA が無ければ `cpu`)で
  入れ、自分の `.venv`(Python 3.10 も uv が用意する)で動く。`UV_PYTHON_PREFERENCE=only-managed` を付ける
  (PC にある別の Python を拾わせない。story-graph で実際に問題になった)。
- uv が PATH に無ければ、アプリの `.venv` に `pip install uv` して使う。
- 設定「サーバーのフォルダ」で別の場所を指せる。story-graph が入れた `D:\GitHub\story-graph\runtime\tts\irodori`
  を指せば入れ直さずに使える(目印ファイルが無くても `pyproject.toml` と `.venv` があれば導入済みとみなす)。
- モデルは **`D:\ai-models\tts\hf-cache`**(ユーザー指定 2026-10-24。`HF_HOME` をここに向ける。story-graph と共用で、
  v4-Small は既に取得済み)。設定「モデルの置き場」で上書きでき、既定フォルダが無い環境では Hugging Face の既定の
  キャッシュを使う。
- バックエンドの `tts.py` が子プロセスとして起動する(`llm_server.py` と同じ作法)。ログは `data/tts-server.log`。
  設定の URL(既定 `http://127.0.0.1:8088`)が既に応答していれば(別のアプリが起動したサーバー)それを使い、止めない。
  `IRODORI_PRELOAD=true` で起動時にモデルを読み込ませ、`/health` の `runtime.loaded` が立つまでを「起動中」とする。
  バックエンド終了時に自分で起動したサーバーは止める。

## 2. API(バックエンド)

| API | 役割 |
|---|---|
| `GET /api/tts/status` | 導入済みか・動いているか(`running` = 合成できる、`starting` = モデルの読み込み中、`external` = 別のアプリのサーバー)、インストールの進み具合(`install`) |
| `POST /api/tts/start` | 起動する(待たずに返す。準備ができたかは status で見る) |
| `POST /api/tts/stop` | 自分で起動したサーバーを止める(VRAM を空ける) |
| `POST /api/tts/install` | `git clone` + `uv sync` を背後で実行する(進み具合は status の `install`) |
| `POST /api/tts/speak` | 本文(4000 字まで)を音声にして返す。`caption` / `ref_wav` / `seed` は設定の値をそのまま渡す |

- 音声の形式は opus(Ogg。wav の 1/10 ほど)。サーバーが opus を出せなければ(ffmpeg も対応する soundfile も無い)
  wav に切り替えて以後 wav で頼む。
- 合成した音声は `data/tts-cache/<sha1(本文+声+形式)>.<拡張子>` に置き、同じ本文・同じ声は合成し直さない(400 MB を超えたら
  古いものから消す)。声の説明・参照音声・seed を変えると鍵が変わるので作り直される。
- サーバーの設定・起動・合成の呼び出しはすべて `backend/app/tts.py`。レンダラは `api.ts` の `getTtsStatus` /
  `startTts` / `stopTts` / `installTts` / `ttsSpeak` を使う。

## 3. 読み上げの流れ(`TextView.tsx`)

- 単位はアプリ用の本文のブロック(段落・見出し・箇条・引用。図・表・コードは読まない)。1,500 字を超えるブロックは
  文の切れ目で分ける。Markdown の記号・リンク・図の参照は落とし、**ルビは読み(`<rt>`)を読む**。
- 英語の本は訳文(日本語)を読む(Irodori-TTS は日本語専用)。「日本語訳」が「原文」のときは読み上げを出さない。
  訳していない段落は飛ばす。
- ツールバーの「読み上げ」は今の画面の先頭のブロックから、段落の右クリックの「ここから読み上げる」はその段落から。
  サーバーが止まっていれば起動してモデルの読み込みを待つ(「読み上げの準備中…」)。
- ブロックごとに `ttsSpeak` を呼び、2 つ先まで先に合成しておく(合成は再生より 3〜5 倍速い。story-graph の実測)。
  読んでいるブロックは CSS Custom Highlight API(`::highlight(speaking)`、`--accent-soft` の淡い面)でハイライトする。
- 読む単位が画面の外にあれば読み上げの側で画面を送る(別の区画なら組み直してから続ける。`pump` と
  `[screen, sec, tick]` の effect の組み合わせ)。手でページを送る・目次やしおりで移る・本文が作り直されると止める。
- 速さ(0.8〜2.0)は `<audio>` の `playbackRate` で変える(音の高さは保たれる。`localStorage` の `readerSpeechRate`)。
  一時停止 / 再開 / 停止。
- 失敗(サーバー未導入・起動失敗・合成エラー)はテキスト表示のエラー行に理由を出して止める。

## 4. 設定(設定 →「読み上げ」)

サーバーの状態(未インストール / 停止中 / 起動中 / 稼働中)と インストール / 起動 / 停止 / 入れ直す、サーバーのフォルダ、
モデルの置き場、サーバーの URL。声は 声の説明(キャプション。既定「穏やかで落ち着いた女性の声。本を朗読するように、
はっきりと読む」)、参照音声(wav)、seed(既定 1234。同じ声を保つ)。`data/settings.json` の `tts`。

## 5. 実測(2026-10-24、RTX PRO 5000 48GB、story-graph の既存インストールと取得済みの v4-Small)

- 起動(モデルの読み込み込み): 34 秒。合成: 3 文(約 7.5 秒の音声)で 1.7 秒、opus で 58 KB。キャッシュに当たれば 5 ms。
- VRAM は story-graph の実測で ロード後 +3.7 GB、合成中は最大 +6 GB 前後。31B Q4_K_M の LLM と同居しても合成の速さは変わらない。

## 6. 今後

- 文の単位のハイライト(今はブロックの単位)。サーバーの SSE(`stream_format: "sse"`)を使えば文ごとの音声が取れる。
- 読み終わりの自動の読書位置の保存は、画面を送る既存の仕組み(`settle`)で済んでいる。
- 感情・絵文字の指定(Irodori の `EMOJI_ANNOTATIONS.md`)。小説の会話文を別の声で読むなど。
