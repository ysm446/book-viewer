"""英語の本のマウスオーバー辞書(英和)。

辞書データは EJDict-hand(https://github.com/kujirahand/EJDict、CC0 / パブリックドメイン)。
初回に引いたとき <リポジトリ>/models/dictionaries/ejdict/ に a.txt〜z.txt を取得し、以後はそこから読む
(models/ は git 管理外)。各行は「見出し語 TAB 意味」で、意味は " / " 区切り。綴りの違う同じ語は
見出し語がカンマ区切りで並ぶ。

引くときは、書かれた形(frightened)で見つからなければ、語尾を外した形(frighten)を試す。
"""

from __future__ import annotations

import string
import threading
import urllib.error
import urllib.request
from pathlib import Path

DICT_DIR = Path(__file__).resolve().parents[2] / "models" / "dictionaries" / "ejdict"
SOURCE_URL = "https://raw.githubusercontent.com/kujirahand/EJDict/master/src/{letter}.txt"
# 1 語に出す意味の上限(残りは「ほか N 件」)
MEANINGS_MAX = 8

_lock = threading.Lock()
_entries: dict[str, list[tuple[str, str]]] | None = None


class DictionaryError(RuntimeError):
    pass


def _download() -> None:
    DICT_DIR.mkdir(parents=True, exist_ok=True)
    for letter in string.ascii_lowercase:
        path = DICT_DIR / f"{letter}.txt"
        if path.is_file():
            continue
        try:
            with urllib.request.urlopen(SOURCE_URL.format(letter=letter), timeout=30) as res:
                data = res.read()
        except (urllib.error.URLError, OSError) as e:
            raise DictionaryError(f"辞書データ(EJDict)を取得できませんでした: {e}") from e
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)


def _load() -> dict[str, list[tuple[str, str]]]:
    global _entries
    with _lock:
        if _entries is not None:
            return _entries
        _download()
        entries: dict[str, list[tuple[str, str]]] = {}
        for path in sorted(DICT_DIR.glob("*.txt")):
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                head, sep, meaning = line.partition("\t")
                if not sep or not meaning.strip():
                    continue
                for word in head.split(","):
                    word = word.strip()
                    if word:
                        entries.setdefault(word.lower(), []).append((word, meaning.strip()))
        _entries = entries
        return entries


def _candidates(word: str) -> list[str]:
    """書かれた形と、語尾を外した形の候補(見つかりやすい順)。"""
    w = word.lower().replace("’", "'").strip("'")
    if w.endswith("'s"):
        w = w[:-2]
    out = [w]

    def add(*forms: str) -> None:
        for f in forms:
            if len(f) >= 2 and f not in out:
                out.append(f)

    def undouble(stem: str) -> str:
        # stopped → stop、running → run
        return stem[:-1] if len(stem) >= 3 and stem[-1] == stem[-2] and stem[-1] not in "aeiou" else stem

    if w.endswith("ies"):
        add(w[:-3] + "y")
    if w.endswith("ied"):
        add(w[:-3] + "y")
    if w.endswith("es"):
        add(w[:-2], w[:-1])
    elif w.endswith("s") and not w.endswith("ss"):
        add(w[:-1])
    if w.endswith("ed"):
        stem = w[:-2]
        add(stem, stem + "e", undouble(stem))
    if w.endswith("ing"):
        stem = w[:-3]
        add(stem, stem + "e", undouble(stem))
    if w.endswith("iest") or w.endswith("ier"):
        add(w[: -4 if w.endswith("iest") else -3] + "y")
    if w.endswith("est"):
        stem = w[:-3]
        add(stem, stem + "e", undouble(stem))
    elif w.endswith("er"):
        stem = w[:-2]
        add(stem, stem + "e", undouble(stem))
    if w.endswith("ily"):
        add(w[:-3] + "y")
    elif w.endswith("ly"):
        add(w[:-2])
    return out


def lookup(word: str) -> dict:
    """{query, entries: [{word, meanings, more}]}。書かれた形の項目と、元の形の項目を最大 2 つ返す。"""
    entries = _load()
    found: list[dict] = []
    seen: set[str] = set()
    for cand in _candidates(word):
        for head, meaning in entries.get(cand, []):
            key = f"{head}\t{meaning}"
            if key in seen:
                continue
            seen.add(key)
            meanings = [m.strip() for m in meaning.split(" / ") if m.strip()]
            found.append(
                {
                    "word": head,
                    "meanings": meanings[:MEANINGS_MAX],
                    "more": max(0, len(meanings) - MEANINGS_MAX),
                }
            )
        if len(found) >= 2:
            break
    return {"query": word, "entries": found[:2]}
