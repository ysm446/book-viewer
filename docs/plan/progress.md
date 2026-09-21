# progress — 進捗と注意点

作成日時: 2026-09-21 17:59
更新日時: 2026-09-21 20:30

## 現在地

M0・M1 完了、M2(文字起こし + テキスト表示)と M3(図の切り抜き)の最初の版まで(マイルストーンは [plan.md](plan.md))。

## 完了

- 2026-09-21: manga-viewer から book-viewer へ改名(アプリ名・パッケージ名・データフォルダ名)。
  旧データフォルダ `.manga-viewer/` は初回アクセス時に `.book-viewer/` へ自動でリネームする。
- 2026-09-21: git リモートを `https://github.com/ysm446/book-viewer.git` に設定。
- 2026-09-21: 1 冊 1 フォルダのライブラリと本の取り込み。
  - backend: `library.py`(本フォルダ・book.json・取り込み)、`routers/library.py`
    (inspect / loose / import)、スキャンを本フォルダ方式に変更、`works` に `author` /
    `writing_mode` 列を追加、名前変更は book.json とフォルダ名、削除は本フォルダごとごみ箱へ。
  - frontend: 取り込みダイアログ(`ImportDialog.tsx`)、一覧上部の `＋`、ドラッグ&ドロップ、
    未取り込みアーカイブの案内。
  - 開発用の管理ルートは `E:\sample files\book-viewer`(`data/settings.json` の `recentRoots` 先頭)。

- 2026-09-21: 文字起こしとテキスト表示(M2 の最初の版)。
  - backend: `transcribe.py`(Vision LLM で 1 枚ずつ Markdown 化 → `pages/0001.md`)、
    解析キューにジョブ種別 `transcribe`、`routers/text.py`、書字方向の変更 API。
  - frontend: リーダーの「画像 / テキスト」切り替え、`TextView.tsx`(横書き / 縦書きの組版、
    未処理ページの文字起こし、やり直し、進捗)、`Markdown` にルビと図の置き場所、
    表示バーに書字方向、一覧メニューに「文字起こしする」。
  - 検証: スクラッチのライブラリで API → キュー → LLM → 保存 → 画面表示(横書き・縦書き)まで確認。

- 2026-09-21: 漫画向けの mokuro / manga-ocr を削除(`ocr.py`、`requirements-ocr.txt`、解析の `use_ocr`)。
- 2026-09-21: M1 文字起こしエンジンの比較(`scripts/ocr-compare/`)。YomiToku / NDLOCR-Lite /
  Qwen3.8-27B を縦書き 4・横書き 2 ページで比べ、YomiToku を既定に採用。
  - backend: `layout_ocr.py`(YomiToku → 段落の分け直し・キャプション判定・見出しの帯 → Markdown、
    図の切り抜き)、`transcribe.py` にエンジン切り替えと `figures/` への保存、図の配信 API。
    文字起こしは LLM 未読み込みでも動く。
  - frontend: `Markdown` に画像(本文中の図)、テキスト表示で図を表示、設定にエンジン選択。

## 次にやること

1. 本文の手修正 UI(原本と見比べて直す)。YomiToku の行ごとの確信度(`rec_score`)が低い箇所に
   印を付けると直す場所を探しやすい。
2. ページ間の段落のつなぎ(前のページの最後の段落が文の途中で終わっている場合)。
3. ルビを `<ruby>` として残す(今は YomiToku の `ignore_ruby` で落としている)。
4. 表を Markdown の表にする(今は画像として切り抜いている)。
5. M4: 章の構造化と要約。

## 注意点

- 本フォルダ方式より前の作品(ルート配下の zip を直接登録したもの)は DB に残っていれば
  読めるが、スキャンでは登録されない。その zip は「未取り込み」として案内に出る。
  取り込むと同じ ID で本フォルダの作品に置き換わり、読書位置・解析結果は引き継がれる。
- 本フォルダが消えた作品はスキャン時に索引から外れ、読書位置・しおりも消える。
- 取り込みダイアログは既存部品(`.modal` / `.seg` / `.btn`)と既存の値で組んだ。エラー色は
  スタイルガイドの `#ff8a8a` を `--danger` トークンとして `:root` に追加して使っている。
  スタイルガイド本体(本文中の manga-viewer 表記、取り込みダイアログ・`--danger` の追記)は未更新。
- 比較の正解テキスト・出力は `data/ocr-compare/`(git 管理外。本の本文を含むため)。
- NDLOCR-Lite の比較用 clone と venv は `vendor/ndlocr-lite/`(git 管理外)。アプリ本体では使っていない。
- YomiToku のモデルは CC BY-NC-SA 4.0(非商用)。個人利用の前提。
- 漫画向けの設定文言・既定プロンプト(`settings.ts` の DEFAULT_SYSTEM_PROMPT など)は
  まだ漫画前提のまま。M2 以降で本向けに置き換える。
