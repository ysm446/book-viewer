# Magiv2 スポット検証

[docs/manga-relationship-graph-notes.md](../../docs/manga-relationship-graph-notes.md) §8 の検証手順。
手持ちの漫画 zip から連続10ページほどを Magiv2 に通し、相関図生成の前提
(bbox 検出・キャラのクラスタリング・話者同定)がその作品で成立するかを目視で判断する。

backend の venv とは依存が競合するため、**必ず専用 venv を作る**。

```powershell
cd scripts/magi-spot-check
py -3 -m venv .venv-magi
./.venv-magi/Scripts/python.exe -m pip install -r requirements.txt

# GPU を使う場合は、先にアプリの llama-server をアンロードして VRAM を空けること。
./.venv-magi/Scripts/python.exe spot_check_magiv2.py "D:\path\to\作品.zip" --start 0 --count 10 --out out

# GPU を使わない場合(遅いが安全):
./.venv-magi/Scripts/python.exe spot_check_magiv2.py "D:\path\to\作品.zip" --cpu
```

## 確認する3点(OCR の文字化けは無視してよい)

- [ ] `out/page_*_annotated.png` でパネルとキャラの bbox が正しく取れているか
- [ ] 同一人物に同じクラスタ(色/ラベル)が付いているか
- [ ] `out/transcript.txt` で話者がおおむね当たっているか

3点が通れば相関図パイプラインの導入判断は GO。キャラのクラスタが混ざるなら
その作品の画風が学習分布の外にあるサインなので方針を再検討する(メモ §8)。

## キャラクターバンク(任意)

`--bank <フォルダ>` に「名前.png」形式でキャラの代表画像を置くと、
台本のラベルがその名前になる(Magiv2 の human-in-the-loop 前提の確認)。
無くても検出・クラスタリングの確認はできる。
