# AGENTS.md

このファイルは、作業するエージェント向けのプロジェクトルールです。

## 基本方針

- このプロジェクト固有の説明、判断基準、運用ルールは日本語で書く。
- コード、コマンド、API 名、ファイルパス、識別子は既存の表記を優先し、無理に翻訳しない。
- 既存の実装方針を確認してから変更する。
- ユーザーの未コミット変更を勝手に戻さない。
- 変更は必要な範囲に留め、無関係な整形やリファクタリングを混ぜない。

## 作業開始時の確認

作業前に、まず以下を確認する。

1. `docs/plan/goals.md`
   - プロジェクトの目的、完成形、重視する価値を把握する。

2. `docs/plan/plan.md`
   - 実装方針、優先順位、今後の予定を把握する。

3. `docs/plan/progress.md`
   - 現在の進捗、完了済み作業、未完了作業、注意点を把握する。

今回の依頼が現在の計画や進捗のどこに関係するかを把握してから作業する。方針と矛盾しそうな場合は、実装前に確認する。

## UI 変更のルール

UI（`src/renderer/` 配下の見た目、`src/renderer/src/styles.css`、新規の画面・部品）を
変更するときは、**着手前に `docs/design/style-guide.md` を読み、その内容に従う。**

- 色は `styles.css` の `:root` カスタムプロパティ（`--panel` / `--text` / `--accent` など）を使う。
  新しい hex 値を各所に直書きしない。必要なときはトークンを追加してから使う。
- アクセント（青 `--accent`）はモデル状態、主アクション、チェック / トグルの ON、focus に限定する。
  選択状態やトグル ON の押し込み表現はグレー（`--panel-3`）にする。
- フォントサイズ、余白、コントロール高さ、角丸は、スタイルガイドの表にある値から選ぶ。
  表に無い値が必要になったら、先にスタイルガイドを更新してから使う。
- 既存部品（ボタン、セグメント、スイッチ、チップ、リスト行、ポップアップ、モーダル、
  トースト等）で組めるものを、似た用途で新規に作らない。
- hover / 選択 / focus / disabled / loading / empty / error の各状態を用意する。
  `:focus-visible` のフォーカスリングを消さない。
- 作業後はスタイルガイド末尾のチェックリストで自己確認し、
  ガイドに無いパターンを追加した場合はスタイルガイド本体にも追記する。

## ドキュメント管理

- `docs/**/*.md` を新規作成または内容更新するときは、本文の先頭付近に作成日時と更新日時を書く。
- 日時は `YYYY-MM-DD HH:MM` 形式で記録する。
- 既存ドキュメントを更新した場合は、更新日時を現在の作業日時に更新する。
- 例:
  - `作成日時: 2026-05-19 22:10`
  - `更新日時: 2026-05-19 22:10`
- `docs/changelog.md` は Git 履歴やユーザー向け変更を追うための履歴として使う。
- `docs/design/` 配下は設計資料、仕様メモ、調査資料を置く場所として使う。
- `docs/plan/goals.md`、`docs/plan/plan.md`、`docs/plan/progress.md` は進捗管理用の入口として保つ。
- `docs/design/style-guide.md` は UI の遵守ルール。UI を触るときは必ず参照する（下記「UI 変更のルール」）。
- 利用者向けの入口は `README.md`。機能・キーボード操作・設定・対応形式を変えたら合わせて直す。

## バージョン管理

- アプリのバージョンは `package.json` の `version` を基準にする。
- ユーザー向けの明確な変更を行った場合は、必要に応じて `docs/changelog.md` に記録する。
- `docs/changelog.md` は日本語で書き、日付見出し（`## YYYY-MM-DD`）に項目をぶら下げる。
  新しい日付が上。日付はコミット日に合わせる。
- まだ正式リリース（タグ付け）を行っていないため、現時点では全項目が未リリース扱い。
  リリースを始めたら、未確定分は先頭に「未リリース」セクションを作って記録する。
- 履歴見出しに時刻まで書く場合は `YYYY-MM-DD HH:MM` 形式を使う。

## コマンド実行ルール

- 各コマンドでは、使う値を先に定義してから使う。
- PowerShell 変数の `$` はエスケープしない。
- 例では具体的な実ファイル名ではなく、必要に応じて `path/to/file.ext` のような一般的なパスを使う。
- ファイル検索は `rg` / `rg --files` を優先する。

## 読み取り手順

UTF-8 no BOM のファイルを行番号付きで読む場合は、次の形式を使う。

```bash
bash -lc 'powershell -NoLogo -Command "
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);
Set-Location -LiteralPath (Convert-Path .);
function Get-Lines { param([string]$Path,[int]$Skip=0,[int]$First=40)
  $enc=[Text.UTF8Encoding]::new($false)
  $text=[IO.File]::ReadAllText($Path,$enc)
  if($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF){ $text=$text.Substring(1) }
  $ls=$text -split \"`r?`n\"
  for($i=$Skip; $i -lt [Math]::Min($Skip+$First,$ls.Length); $i++){ \"{0:D4}: {1}\" -f ($i+1), $ls[$i] }
}
Get-Lines -Path \"path/to/file.ext\" -First 120 -Skip 0
"'
```

## 書き込み手順

通常の編集は `apply_patch` を優先する。PowerShell で UTF-8 no BOM の atomic replace が必要な場合は、次の形式を使う。

```bash
bash -lc 'powershell -NoLogo -Command "
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);
Set-Location -LiteralPath (Convert-Path .);
function Write-Utf8NoBom { param([string]$Path,[string]$Content)
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $tmp = [IO.Path]::GetTempFileName()
  try {
    $enc = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText($tmp,$Content,$enc)
    Move-Item $tmp $Path -Force
  }
  finally {
    if (Test-Path $tmp) {
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
  }
}
$file = \"path/to/your_file.ext\"
$enc  = [Text.UTF8Encoding]::new($false)
$old  = (Test-Path $file) ? ([IO.File]::ReadAllText($file,$enc)) : ''
Write-Utf8NoBom -Path $file -Content ($old+\"`nYOUR_TEXT_HERE`n\")
"'
```

## 検証

- フロントエンドや型に関わる変更後は、可能な限り `npm run build` を実行する。
- バックエンド Python の単体ファイル変更では、可能な限り `py_compile` などで構文確認する。
- 検証できなかった場合は、その理由を作業報告に書く。
