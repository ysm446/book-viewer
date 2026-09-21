"""ファイル内容フィンガープリント。

パス非依存に本を識別するため、ファイルサイズと先頭ブロックのハッシュから
安定した ID を作る。これにより移動 / リネーム後も再スキャンで再リンクできる。
(docs/plan/plan.md「ファイル識別」)
"""

from __future__ import annotations

import hashlib
from pathlib import Path

# 先頭から読むバイト数。スキャン速度と衝突耐性のバランス。
_HEAD_BYTES = 64 * 1024


def compute(path: Path) -> str:
    size = path.stat().st_size
    h = hashlib.sha1()
    h.update(str(size).encode("utf-8"))
    with path.open("rb") as f:
        h.update(f.read(_HEAD_BYTES))
    return h.hexdigest()
