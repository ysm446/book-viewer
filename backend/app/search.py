"""本の全文検索(書名・著者・章の要約・本全体の要約・文字起こしした本文・英語の本の訳文)。

FTS5(trigram) を主に使い、未対応環境や短い語(<3 文字)は書名・著者の LIKE で代替する。
索引は library.db の search_index(本の単位。一覧の絞り込み)と、検索結果の画面に使う段落の単位の
passage_index(アプリ用の本文のブロック)・passage_ja(英語の本の訳したブロックの訳文)で、どれも
本フォルダから作り直せる。スキャン時と、文字起こし・章立てと要約・翻訳のジョブが終わったときに作り直す。
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
from pathlib import Path

from .db import connect

# 索引の作り方を変えたら上げる(指紋が変わり、次のスキャンで全冊を作り直す)。
_INDEX_VERSION = "3"


def _fts_available(conn: sqlite3.Connection) -> bool:
    try:
        conn.execute("SELECT 1 FROM search_index LIMIT 1")
        return True
    except sqlite3.OperationalError:
        return False


def _book_text(root: Path, work_id: str) -> tuple[str, list[tuple], list[tuple]]:
    """索引に入れる本文と要約、段落の並び [(ブロックの添字, 原本のページ, 本文)]、
    訳文の並び [(ブロックの添字, 原本のページ, 訳文, 訳の組の JSON)]。

    本フォルダ方式でなければどれも空。訳文は英語の本で訳したブロックだけ。
    """
    from . import content, structure, transcribe, translate  # transcribe → progress → … の循環を避けてここで読む

    parts: list[str] = []
    passages: list[tuple] = []
    translations: list[tuple] = []
    try:
        st = structure.get_structure(root, work_id)
        if st.get("book_summary"):
            parts.append(st["book_summary"])
        for ch in st.get("chapters") or []:
            parts.append(ch["title"])
            if ch.get("summary"):
                parts.append(ch["summary"])
        # 本文はアプリ用の本文(ページをまたいで切れた段落をつないだもの)から取る。
        # 添字はテキスト表示のブロックと同じ(検索結果からその段落へ飛ぶ)。
        blocks = content.load(root, work_id)["blocks"]
        for i, block in enumerate(blocks):
            text = transcribe.plain_for_llm(block["md"])
            if text:
                parts.append(text)
                passages.append((i, int(block["page"]), text))
        # 訳文は組の訳文をつないだもの(検索結果で、一致した位置から組 = 原文の文へ戻れるように)。
        for i, pairs in translate.block_pairs(root, work_id, blocks).items():
            ja = "".join(p[1] for p in pairs)
            if ja:
                parts.append(ja)
                translations.append((i, int(blocks[i]["page"]), ja, json.dumps(pairs, ensure_ascii=False)))
    except Exception:  # noqa: BLE001 - 本フォルダでない・読めないときは書名だけで索引する
        pass
    return "\n".join(parts), passages, translations


def content_signature(book_dir: Path | None, title: str, author: str) -> str:
    """索引の元になるものの指紋(書名・著者と、本文・要約・訳のファイルの数と更新時刻)。

    ファイルの中身は読まない(スキャンのたびに全ページを読まないための目安)。
    """
    parts = [f"v{_INDEX_VERSION}", title, author]
    if book_dir is not None:
        for sub in ("pages", "summaries", "translation"):
            d = book_dir / sub
            if not d.is_dir():
                continue
            latest = 0
            count = 0
            for f in d.iterdir():
                try:
                    latest = max(latest, f.stat().st_mtime_ns)
                except OSError:
                    continue
                count += 1
            parts.append(f"{sub}:{count}:{latest}")
        try:
            parts.append(str((book_dir / "book.json").stat().st_mtime_ns))
        except OSError:
            pass
    return "|".join(parts)


def update_index(
    conn: sqlite3.Connection,
    root: Path,
    work_id: str,
    *,
    book_dir: Path | None = None,
    only_if_changed: bool = False,
) -> None:
    """既存接続内で、本の検索索引の行を作り直す。

    only_if_changed=True なら、前回索引を作ったときと指紋(content_signature)が同じ本は
    読み直さない。
    """
    try:
        row = conn.execute("SELECT title, author FROM works WHERE id = ?", (work_id,)).fetchone()
        if not row:
            return
        sig = content_signature(book_dir, row["title"], row["author"])
        if only_if_changed:
            prev = conn.execute(
                "SELECT signature FROM search_meta WHERE work_id = ?", (work_id,)
            ).fetchone()
            if prev and prev["signature"] == sig:
                return
        text, passages, translations = _book_text(root, work_id)
        content = "\n".join(p for p in (row["title"], row["author"], text) if p)
        conn.execute("DELETE FROM search_index WHERE work_id = ?", (work_id,))
        conn.execute("INSERT INTO search_index (work_id, content) VALUES (?, ?)", (work_id, content))
        conn.execute("DELETE FROM passage_index WHERE work_id = ?", (work_id,))
        conn.executemany(
            "INSERT INTO passage_index (work_id, block, page, text) VALUES (?, ?, ?, ?)",
            [(work_id, *p) for p in passages],
        )
        conn.execute("DELETE FROM passage_ja WHERE work_id = ?", (work_id,))
        conn.executemany(
            "INSERT INTO passage_ja (work_id, block, page, text, pairs) VALUES (?, ?, ?, ?, ?)",
            [(work_id, *t) for t in translations],
        )
        conn.execute(
            "INSERT INTO search_meta (work_id, signature) VALUES (?, ?) "
            "ON CONFLICT(work_id) DO UPDATE SET signature = excluded.signature",
            (work_id, sig),
        )
    except sqlite3.OperationalError:
        # FTS5 未対応環境では索引を持たない(検索時 LIKE で代替)。
        pass


def remove_index(conn: sqlite3.Connection, work_id: str) -> None:
    """本の検索索引の行を削除する(本の削除時)。"""
    try:
        conn.execute("DELETE FROM search_meta WHERE work_id = ?", (work_id,))
        conn.execute("DELETE FROM search_index WHERE work_id = ?", (work_id,))
        conn.execute("DELETE FROM passage_index WHERE work_id = ?", (work_id,))
        conn.execute("DELETE FROM passage_ja WHERE work_id = ?", (work_id,))
    except sqlite3.OperationalError:
        pass


def search(root: Path, q: str) -> list[str]:
    q = q.strip()
    if not q:
        return []
    with connect(root) as conn:
        if _fts_available(conn) and len(q) >= 3:
            try:
                phrase = '"' + q.replace('"', '""') + '"'
                rows = conn.execute(
                    "SELECT work_id FROM search_index WHERE search_index MATCH ?", (phrase,)
                ).fetchall()
                return [r["work_id"] for r in rows]
            except sqlite3.OperationalError:
                pass
        # LIKE フォールバック(短い語 / FTS なし)。% と _ はそのままだとワイルドカードになる。
        like = _like(q)
        rows = conn.execute(
            "SELECT id AS work_id FROM works WHERE title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\'",
            (like, like),
        ).fetchall()
        return [r["work_id"] for r in rows]


# ---- 箇所の検索(検索結果の画面) ------------------------------------------------

# 1 回の検索で読む段落の上限(よくある語で全冊の段落を読み込まないため)。件数はここで頭打ちになる。
_PASSAGE_CAP = 5000
# 抜粋の長さ(字)と、最初に一致した語の前に残す字数。
_SNIPPET_LEN = 160
_SNIPPET_BEFORE = 50
# 抜粋に添える訳・原文の長さの目安(短い文は次の組も足す)と上限(字)。
_PAIR_MIN = {"ja": 60, "en": 120}
_PAIR_MAX = 200
# 本ごとのまとめに出す箇所の数(残りは「すべて表示」で本を指定して取り直す)。
_HITS_PER_BOOK = 3
# 意味の近さで拾う段落の数(全冊 / 1 冊)と、順位を混ぜる RRF の定数(よく使われる 60)。
_SEMANTIC_ALL = 30
_SEMANTIC_BOOK = 50
_RRF_K = 60
_TERM_RE = re.compile(r'"([^"]+)"|(\S+)')


def parse_terms(q: str) -> list[str]:
    """検索語を語に分ける(空白区切りで、すべてを含む段落を探す)。"…" で囲むと空白を含む語になる。"""
    terms: list[str] = []
    for m in _TERM_RE.finditer(q.replace("　", " ")):
        t = (m.group(1) or m.group(2) or "").strip()
        if t and t.lower() not in (x.lower() for x in terms):
            terms.append(t)
    return terms[:8]


def _like(t: str) -> str:
    return "%" + t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _occurrences(text: str, term: str) -> list[int]:
    lower, needle = text.lower(), term.lower()
    out: list[int] = []
    i = lower.find(needle)
    while i >= 0:
        out.append(i)
        i = lower.find(needle, i + len(needle))
    return out


def _score(text: str, terms: list[str]) -> float:
    """段落の順位の目安。語がよく出てくるほど高く、長い段落ほど割り引く(同じ語の数え過ぎは 3 回まで)。"""
    hits = sum(min(len(_occurrences(text, t)), 3) for t in terms)
    return hits / (1 + math.log1p(len(text) / 200))


def _first_match(text: str, terms: list[str]) -> int:
    firsts = [o[0] for t in terms if (o := _occurrences(text, t))]
    return min(firsts) if firsts else 0


def snippet(text: str, terms: list[str]) -> tuple[str, list[list[int]]]:
    """段落から最初に一致した語の付近を切り出し、(抜粋, 抜粋の中の一致の位置 [[始, 終], …]) を返す。"""
    first = _first_match(text, terms)
    start = max(0, first - _SNIPPET_BEFORE)
    end = min(len(text), start + _SNIPPET_LEN)
    start = max(0, end - _SNIPPET_LEN)
    body = text[start:end].replace("\n", " ")
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    marks: list[list[int]] = []
    for t in terms:
        for i in _occurrences(body, t):
            marks.append([len(prefix) + i, len(prefix) + i + len(t)])
    # 重なった一致はつなぐ
    marks.sort()
    merged: list[list[int]] = []
    for s, e in marks:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return prefix + body + suffix, merged


def _pair_excerpt(pairs: list[list[str]], k: int, side: str) -> str:
    """訳の組の k 番目から、原文(side="en")か訳文("ja")を目安の長さまでつないで返す。"""
    i = 0 if side == "en" else 1
    sep = " " if side == "en" else ""
    out = ""
    end = k
    while end < len(pairs) and (end == k or len(out) < _PAIR_MIN[side]):
        out += (sep if out else "") + pairs[end][i]
        end += 1
    more = end < len(pairs) or len(out) > _PAIR_MAX
    return ("…" if k > 0 else "") + out[:_PAIR_MAX] + ("…" if more else "")


def _chapter_label(chapters: list[dict], page: int) -> str:
    """原本のページが入る章(と節)の名前。章立てが無ければ空。"""
    for ch in chapters:
        if ch["start"] <= page <= ch["end"]:
            sec = [s for s in ch.get("sections") or [] if s["page"] <= page]
            return f"{ch['title']} › {sec[-1]['title']}" if sec else ch["title"]
    return ""


def _find(conn: sqlite3.Connection, table: str, columns: str, terms: list[str], work_id: str | None) -> list:
    """table(passage_index / passage_ja)で、すべての語を含む行(3 文字以上の語は MATCH、短い語は LIKE)。"""
    where: list[str] = []
    params: list[object] = []
    long_terms = [t for t in terms if len(t) >= 3]
    if long_terms:
        where.append(f"{table} MATCH ?")
        params.append(" ".join('"' + t.replace('"', '""') + '"' for t in long_terms))
    for t in terms:
        if len(t) < 3:
            where.append("text LIKE ? ESCAPE '\\'")
            params.append(_like(t))
    if work_id:
        where.append("work_id = ?")
        params.append(work_id)
    try:
        return conn.execute(
            f"SELECT {columns} FROM {table} WHERE {' AND '.join(where)} LIMIT ?",
            (*params, _PASSAGE_CAP + 1),
        ).fetchall()
    except sqlite3.OperationalError:
        return []  # FTS5 の無い環境では箇所の検索はできない


def search_passages(root: Path, q: str, work_id: str | None = None) -> dict:
    """本文の段落を探し、本ごとにまとめて返す。

    語の一致(すべての語を含む段落。英語の本は訳文も探すので日本語の語でも見つかる。原文でも訳文でも
    一致した段落は原文の一致として扱う)と、意味の近さ(段落の埋め込み。索引のある本だけ)の 2 つの順位を
    RRF で混ぜて並べる。work_id を渡すとその本だけを、まとめずにページ順で返す(「すべて表示」)。
    本の並びは書名に語を含む本を先に、その次はいちばん順位の高い箇所の順。

    箇所の match は text(原文で一致)/ ja(訳文で一致)/ meaning(意味が近いだけ)。snippet / marks は
    原文の抜粋と一致の位置、ja / ja_marks は訳文。原文で一致・意味が近いときは、訳してあれば一致した文
    (無ければ段落の初め)の訳を ja に添える(ja_marks は空)。訳文で一致したときは、snippet に一致した文の
    原文、ja に訳文の抜粋を入れる(marks は空)。semantic は意味で探せた本の数と、探せなかった理由。
    """
    from . import embedding, structure  # transcribe → progress → … の循環を避けてここで読む

    terms = parse_terms(q)
    if not terms:
        return {"terms": [], "books": [], "total": 0, "capped": False, "semantic": None}
    semantic: dict = {"indexed": 0, "books": 0, "error": None}
    try:
        near, semantic["indexed"] = embedding.search_passages(
            root, q, work_id, k=_SEMANTIC_BOOK if work_id else _SEMANTIC_ALL
        )
    except embedding.EmbeddingError as e:
        near, semantic["error"] = [], str(e)
    with connect(root) as conn:
        en_rows = _find(conn, "passage_index", "work_id, block, page, text", terms, work_id)
        ja_rows = _find(conn, "passage_ja", "work_id, block, page, text, pairs", terms, work_id)
        works = {
            r["id"]: dict(r)
            for r in conn.execute(
                "SELECT w.id, w.title, w.author, COALESCE(rs.last_page, 0) AS last_page, "
                "COALESCE(rs.completed, 0) AS completed "
                "FROM works w LEFT JOIN reading_state rs ON rs.work_id = w.id"
            ).fetchall()
        }
        semantic["books"] = len(works)
        capped = len(en_rows) > _PASSAGE_CAP or len(ja_rows) > _PASSAGE_CAP

        found: dict[str, dict[int, dict]] = {}
        for r in en_rows[:_PASSAGE_CAP]:
            found.setdefault(r["work_id"], {})[int(r["block"])] = {
                "page": int(r["page"]), "text": r["text"], "pairs": None, "match": "text",
                "score": _score(r["text"], terms),
            }
        for r in ja_rows[:_PASSAGE_CAP]:
            book = found.setdefault(r["work_id"], {})
            block = int(r["block"])
            if block not in book:
                book[block] = {
                    "page": int(r["page"]), "text": r["text"], "pairs": json.loads(r["pairs"]), "match": "ja",
                    "score": _score(r["text"], terms),
                }
        # 順位を混ぜる(RRF): 語の一致の順位と意味の近さの順位から 1 / (定数 + 順位) を足す。
        keyword = sorted(
            ((wid, b, h["score"]) for wid, by in found.items() for b, h in by.items()), key=lambda x: -x[2]
        )
        for rank, (wid, b, _) in enumerate(keyword, 1):
            found[wid][b]["rrf"] = 1 / (_RRF_K + rank)
        missing: dict[str, list[int]] = {}
        for rank, n in enumerate(near, 1):
            hit = found.get(n["work_id"], {}).get(n["block"])
            if hit is None:
                hit = found.setdefault(n["work_id"], {})[n["block"]] = {
                    "page": n["page"], "text": None, "pairs": None, "match": "meaning", "rrf": 0.0
                }
                missing.setdefault(n["work_id"], []).append(n["block"])
            hit["rrf"] += 1 / (_RRF_K + rank)
        # 意味が近いだけの段落の本文
        for wid, blocks in missing.items():
            for r in conn.execute(
                f"SELECT block, text FROM passage_index WHERE work_id = ? AND block IN ({','.join('?' * len(blocks))})",
                (wid, *blocks),
            ).fetchall():
                found[wid][int(r["block"])]["text"] = r["text"]

        books = []
        for wid, by_block in found.items():
            w = works.get(wid)
            hits = [{"block": b, **h} for b, h in by_block.items() if h["text"] is not None]
            if not w or not hits:
                continue
            if work_id:
                hits.sort(key=lambda h: h["block"])
                shown = hits
            else:
                hits.sort(key=lambda h: (-h["rrf"], h["block"]))
                shown = hits[:_HITS_PER_BOOK]
            # 原文で一致・意味が近いだけの箇所に添える訳(訳してある段落だけ)
            need = [h["block"] for h in shown if h["pairs"] is None]
            tr = {
                int(r["block"]): json.loads(r["pairs"])
                for r in conn.execute(
                    f"SELECT block, pairs FROM passage_ja WHERE work_id = ? AND block IN ({','.join('?' * len(need))})",
                    (wid, *need),
                ).fetchall()
            } if need else {}
            try:
                chapters = structure.get_structure(root, wid)["chapters"]
            except Exception:  # noqa: BLE001 - 章立てが読めなくても箇所は出す
                chapters = []
            title_lower = w["title"].lower()
            books.append(
                {
                    "work_id": wid,
                    "title": w["title"],
                    "author": w["author"],
                    "count": len(hits),
                    "title_match": any(t.lower() in title_lower for t in terms),
                    "best": max(h["rrf"] for h in hits),
                    "hits": [
                        {
                            "block": h["block"],
                            "page": h["page"],
                            "chapter": _chapter_label(chapters, h["page"]),
                            "match": h["match"],
                            # まだ読んでいない所(読み終えた本は無し)。ネタバレに気づけるように印を付ける
                            "ahead": not w["completed"] and h["page"] > w["last_page"],
                            **_hit_texts(h, tr.get(h["block"]), terms),
                        }
                        for h in shown
                    ],
                }
            )
    books.sort(key=lambda b: (not b["title_match"], -b["best"], b["title"]))
    for b in books:
        del b["best"]
    return {
        "terms": terms,
        "books": books,
        "total": sum(b["count"] for b in books),
        "capped": capped,
        "semantic": semantic,
    }


def _hit_texts(hit: dict, pairs: list[list[str]] | None, terms: list[str]) -> dict:
    """箇所に出す原文と訳文の抜粋({snippet, marks, ja, ja_marks})。"""
    if hit["pairs"] is None:
        text, marks = snippet(hit["text"], terms)
        ja = None
        if pairs:
            needles = [t.lower() for t in terms]
            k = next((i for i, p in enumerate(pairs) if any(t in p[0].lower() for t in needles)), 0)
            ja = _pair_excerpt(pairs, k, "ja")
        return {"snippet": text, "marks": marks, "ja": ja, "ja_marks": []}
    # 訳文で一致: 一致した位置の組を探し、その原文を添える
    pairs = hit["pairs"]
    first = _first_match(hit["text"], terms)
    k, at = 0, 0
    for i, p in enumerate(pairs):
        if first < at + len(p[1]):
            k = i
            break
        at += len(p[1])
    ja, ja_marks = snippet(hit["text"], terms)
    return {"snippet": _pair_excerpt(pairs, k, "en"), "marks": [], "ja": ja, "ja_marks": ja_marks}
