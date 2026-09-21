# CLAUDE.md

このファイルは Claude Code 向けのプロジェクト案内です。詳細な運用ルールは [AGENTS.md](AGENTS.md) を参照。

## このプロジェクト

本（小説・技術書）のスクリーンショット zip を取り込み、ローカル LLM で本文を Markdown 化・
構造化（図の切り抜き・章の要約）して、読みながら内容についてチャットできるブックリーダー。
manga-viewer を土台に作り替え中。

## 作業前に必ず読む

1. [docs/plan/goals.md](docs/plan/goals.md) — 目的・完成形・重視する価値
2. [docs/plan/plan.md](docs/plan/plan.md) — アーキテクチャ・データモデル・マイルストーン
3. [docs/plan/progress.md](docs/plan/progress.md) — 現在の進捗・申し送り

ルール全般は [AGENTS.md](AGENTS.md)、UI は [docs/design/style-guide.md](docs/design/style-guide.md)。

## UI を変更するときは必ず

**UI（`src/renderer/` の見た目、`styles.css`、新しい画面や部品）を変更する前に、
[docs/design/style-guide.md](docs/design/style-guide.md) を読み、その内容に従う。**

- 色は `styles.css` の `:root` トークンを使い、新しい hex を直書きしない。
- 青（`--accent`）はモデル状態・主アクション・チェック / トグル ON・focus に限定する。
  選択やトグル ON のグレー表現は `--panel-3`。
- フォントサイズ・余白・高さ・角丸は、スタイルガイドの表にある値から選ぶ。
- 既存部品（ボタン / セグメント / チップ / モーダル / トースト等）で組めるものを新規に作らない。
- 作業後はスタイルガイド末尾のチェックリストで確認する。
- ガイドに無い新しいパターンを追加したときは、実装と同時にスタイルガイドへ追記する。

## ドキュメント運用

- `docs/**/*.md` を新規作成 / 更新したら、本文の先頭付近に `作成日時:` / `更新日時:` を
  `YYYY-MM-DD HH:MM` 形式で書く。更新時は `更新日時:` を現在の作業日時にする。
- ユーザー向けの変更を入れたら [docs/changelog.md](docs/changelog.md) に日本語で追記する。
  日付見出し（`## YYYY-MM-DD`、新しいものが上）にぶら下げる。まだリリース（タグ付け）は
  していないので、全項目が未リリース扱い。バージョンは `package.json` の `version` が基準。
- 進捗管理の入口は `docs/plan/`（goals / plan / progress）、設計・調査メモは `docs/design/`。
- README.md は利用者向けの入口。機能・キーボード操作・設定タブを変えたら合わせて直す。

## 技術スタック

- フロント: Electron + React + TypeScript（electron-vite / Vite）
- バックエンド: Python（FastAPI / uvicorn）。`backend/.venv` の venv を使う。
- ローカル LLM: llama.cpp 系を直接（`vendor/llama_cpp/versions/<version>/llama-server` を起動して HTTP）
- データ: 1 冊 1 フォルダ（`<管理ルート>/<書名>/book.json` + `source/`、正本）+ 索引の SQLite（`<管理ルート>/.book-viewer/library.db`）

## ディレクトリ

```
src/main/        Electron メインプロセス（ウィンドウ、Python 起動・死活監視）
src/preload/     contextBridge による IPC 公開
src/renderer/    React UI（一覧 / リーダー）
backend/app/     FastAPI（scanner / archive / db / routers）
models/          GGUF モデル（git 管理外）
vendor/          llama.cpp 等の外部バイナリ（git 管理外）
data/            実行時生成物（git 管理外）
```

役割分担: 重い処理（zip 展開・画像処理・LLM）は Python に寄せ、Renderer は表示専念。
ページ画像も `GET /api/works/{id}/pages/{n}` で Python から取得する。

## 開発コマンド

```bash
# 初回セットアップ
npm install
cd backend && py -3 -m venv .venv && ./.venv/Scripts/python.exe -m pip install -r requirements.txt

# 起動（Electron が venv の Python backend を自動起動する）
npm run dev

# 型チェック / ビルド
npm run typecheck
npm run build

# バックエンド単体（デバッグ用）
cd backend && ./.venv/Scripts/python.exe -m uvicorn app.main:app --port 8771
```

## 検証

- フロント / 型に関わる変更後は `npm run typecheck`、可能なら `npm run build`。
- バックエンド変更後は `py_compile` か簡易スクリプトで動作確認する。
