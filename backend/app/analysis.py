"""ローカル Vision LLM による作品解析(代表ページ → あらすじ + タグ)。"""

from __future__ import annotations

import base64
import io
import json
import random
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from PIL import Image

from . import archive, llm, ocr, search
from .db import connect


class Cancelled(Exception):
    """解析が中断されたことを表す。"""

# 解析の進捗(work_id -> {current, total, phase})。別スレッドの進捗取得用。
_progress_lock = threading.Lock()
_progress: dict[str, dict] = {}


def set_progress(work_id: str, current: int, total: int, phase: str) -> None:
    with _progress_lock:
        _progress[work_id] = {"current": current, "total": total, "phase": phase}


def get_progress(work_id: str) -> dict | None:
    with _progress_lock:
        return _progress.get(work_id)


def clear_progress(work_id: str) -> None:
    with _progress_lock:
        _progress.pop(work_id, None)

# 解析用に画像を縮小する長辺(コスト削減)。
_ANALYZE_MAX = 1024

# 直前 K ページ文脈(生キャプション)の K の上限。story_every をそのまま K に使うと
# プロンプトが K で線形に膨らみ、走行まとめ導入の趣旨と矛盾するため頭打ちにする。
_CAUSAL_K_MAX = 8


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sample_indices(count: int, n: int) -> list[int]:
    """表紙(0)を含め、等間隔で代表ページの index を選ぶ。"""
    if count <= 0:
        return []
    if count <= n:
        return list(range(count))
    step = count / n
    idxs = sorted({min(count - 1, int(i * step)) for i in range(n)})
    idxs[0] = 0
    return idxs


def _data_url(raw: bytes) -> str:
    """ページ画像バイト列を縮小 JPEG にして data URL 化する。"""
    with Image.open(io.BytesIO(raw)) as img:
        img = img.convert("RGB")
        img.thumbnail((_ANALYZE_MAX, _ANALYZE_MAX))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=85)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def _parse_json(text: str) -> dict:
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


_PAGE_PROMPT = (
    "これは漫画の1ページです。描かれている場面・登場人物・出来事を日本語で簡潔に説明してください。"
    "セリフが読み取れれば要点も含めてください。3文以内で。"
)

# OCR 抽出があるページ用。セリフは OCR テキストを正とし、画像からの読み取り直しを
# 禁止する(Gemma の縦書き誤読が正しい OCR 結果と混ざる「二重読み」の防止)。
# 画像の役割を絵の解釈に純化する — 文字は専用モデル、解釈は VLM の分業。
_PAGE_PROMPT_WITH_OCR = (
    "これは漫画の1ページです。描かれている場面・登場人物・出来事を日本語で簡潔に説明してください。"
    "セリフは上記の抽出テキストを正とし、画像から文字を読み取り直さないこと。"
    "画像は場面・人物・表情・動きの解釈に使うこと。セリフの要点も含めて3文以内で。"
)


def _ocr_block(text: str | None) -> str:
    """OCR で抽出したセリフを、ページ解析プロンプトに添える文脈に整形する。"""
    if not text:
        return ""
    return f"このページから OCR で抽出したセリフ・文字(読み順や話者の対応は不正確なことがある):\n{text}"


_SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "tags"],
}


def _aggregate_prompt(title: str, captions: list[str]) -> str:
    joined = "\n".join(f"- {c}" for c in captions)
    return (
        f"以下は漫画『{title}』の代表ページの説明です。\n{joined}\n\n"
        "これらを踏まえ、作品全体のあらすじを3〜5文の日本語でまとめ、"
        "ジャンルや要素を表すタグを5〜10個挙げてください。"
        '出力は次の JSON のみ: {"summary": "...", "tags": ["...", "..."]}'
    )


def pick_incremental(
    total: int, analyzed: set[int], batch: int, focus: int | None
) -> list[int]:
    """未解析ページから次に解析する分を選ぶ(開いているページ + 初回は表紙 + 残りランダム)。"""
    remaining = [i for i in range(total) if i not in analyzed]
    if not remaining:
        return []
    chosen: list[int] = []
    if focus is not None and 0 <= focus < total and focus in remaining:
        chosen.append(focus)
    if not analyzed and 0 in remaining and 0 not in chosen:
        chosen.append(0)  # 初回は表紙も
    pool = [i for i in remaining if i not in chosen]
    random.shuffle(pool)
    for i in pool:
        if len(chosen) >= batch:
            break
        chosen.append(i)
    return sorted(chosen[: max(1, batch)])


def _save_page(
    root: Path,
    work_id: str,
    page: int,
    description: str,
    text: str | None,
    model: str,
    context_mode: str | None = None,
) -> None:
    """ページ解析結果を保存する。context_mode は生成時の文脈モード
    ('story_state' / 'prev_k' / 'none')。精度検証やドリフト追跡の手がかりに残す。"""
    with connect(root) as conn:
        conn.execute(
            """
            INSERT INTO page_analysis (work_id, page, description, text, model, context_mode, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(work_id, page) DO UPDATE SET
                description = excluded.description,
                text = excluded.text,
                model = excluded.model,
                context_mode = excluded.context_mode,
                created_at = excluded.created_at
            """,
            (work_id, page, description, text, model, context_mode, _now()),
        )
        conn.commit()


def get_analyzed_pages(root: Path, work_id: str) -> list[int]:
    with connect(root) as conn:
        return [
            r["page"]
            for r in conn.execute(
                "SELECT page FROM page_analysis WHERE work_id = ? ORDER BY page", (work_id,)
            ).fetchall()
        ]


def get_page_analysis(root: Path, work_id: str, page: int) -> dict | None:
    with connect(root) as conn:
        r = conn.execute(
            "SELECT page, description, text, model, context_mode, created_at FROM page_analysis "
            "WHERE work_id = ? AND page = ?",
            (work_id, page),
        ).fetchone()
    return dict(r) if r else None


def _all_page_descriptions(root: Path, work_id: str) -> list[tuple[int, str]]:
    with connect(root) as conn:
        return [
            (r["page"], r["description"] or "")
            for r in conn.execute(
                "SELECT page, description FROM page_analysis WHERE work_id = ? ORDER BY page",
                (work_id,),
            ).fetchall()
        ]


def _title(root: Path, work_id: str) -> str:
    with connect(root) as conn:
        r = conn.execute("SELECT title FROM works WHERE id = ?", (work_id,)).fetchone()
    return r["title"] if r else work_id


def _prev_descriptions(root: Path, work_id: str, before_page: int, k: int) -> list[tuple[int, str]]:
    """before_page より前の、解析済みページ説明を最大 k 件(時系列順)返す。"""
    if k <= 0 or before_page <= 0:
        return []
    with connect(root) as conn:
        rows = conn.execute(
            "SELECT page, description FROM page_analysis "
            "WHERE work_id = ? AND page < ? AND description IS NOT NULL AND description != '' "
            "ORDER BY page DESC LIMIT ?",
            (work_id, before_page, k),
        ).fetchall()
    return [(r["page"], r["description"]) for r in reversed(rows)]


def _prev_context_block(root: Path, work_id: str, idx: int, context_count: int) -> str:
    """直前ページ文脈のブロック(無ければ空文字)を作る。"""
    if context_count <= 0:
        return ""
    prevs = _prev_descriptions(root, work_id, idx, context_count)
    if not prevs:
        return ""
    return "前のページの内容(参考。同じ説明の繰り返しは不要):\n" + "\n".join(
        f"- {p + 1}ページ: {d}" for p, d in prevs
    )


# ---- 走行まとめ(物語の状態 = story state)----------------------------------
#
# 直前 K ページの生キャプションを都度添える代わりに、作品全体を圧縮した
# 「物語の状態」(あらすじ + 登場人物 + 伏線 + タグ)を JSON で保持し、
# ページ解析ごとに前置きする。状態は M ページごとに走行更新(ローリング)する。
# 詳細な設計意図は docs/design/analysis-story-state.md を参照。


def _get_story_state(root: Path, work_id: str) -> dict:
    with connect(root) as conn:
        r = conn.execute(
            "SELECT story_state FROM analysis WHERE work_id = ?", (work_id,)
        ).fetchone()
    if r and r["story_state"]:
        try:
            v = json.loads(r["story_state"])
            if isinstance(v, dict):
                # 旧形式(threads が文字列配列)も現行スキーマに揃えて返す。
                return _normalize_story_state(v)
        except json.JSONDecodeError:
            pass
    return {}


def _save_story_state(root: Path, work_id: str, state: dict, model: str) -> None:
    payload = json.dumps(state, ensure_ascii=False)
    with connect(root) as conn:
        conn.execute(
            """
            INSERT INTO analysis (work_id, story_state, status, model, created_at)
            VALUES (?, ?, 'running', ?, ?)
            ON CONFLICT(work_id) DO UPDATE SET
                story_state = excluded.story_state,
                model = excluded.model,
                created_at = excluded.created_at
            """,
            (work_id, payload, model, _now()),
        )
        conn.commit()


def _char_label(c: dict) -> str:
    """登場人物 1 件を「名前[別名](メモ)」形式の短い表記にする。"""
    label = str(c.get("name", "")).strip()
    aliases = [str(a).strip() for a in (c.get("aliases") or []) if str(a).strip()]
    if aliases:
        label += f"[{'/'.join(aliases)}]"
    notes = str(c.get("notes", "")).strip()
    return f"{label}({notes})" if notes else label


def _story_context_block(state: dict) -> str:
    """物語の状態を、ページ解析プロンプトに前置きする短い文脈に整形する。"""
    syn = (state.get("synopsis") or "").strip()
    chars = state.get("characters") or []
    lines: list[str] = []
    if syn:
        lines.append(f"あらすじ: {syn}")
    if isinstance(chars, list) and chars:
        names = "; ".join(
            _char_label(c) for c in chars[:12] if isinstance(c, dict) and c.get("name")
        )
        if names:
            lines.append(f"登場人物: {names}")
            # 語彙統制: 呼び方を state の人物名に揃えると、ページ間で説明が
            # 統一され、後段の同一人物統合・取り違えが減る。
            lines.append("このページに上記の人物が描かれていれば、その名前で呼ぶこと。")
    if not lines:
        return ""
    return "これまでの物語(参考。矛盾する場合は画像を優先):\n" + "\n".join(lines)


# 走行 state の JSON スキーマ(constrained decoding 用)。ページ番号(provenance)は
# キャプション行の「Nページ」と同じ 1 始まりの表示ページ番号で持つ。
_STORY_STATE_SCHEMA = {
    "type": "object",
    "properties": {
        "synopsis": {"type": "string"},
        "characters": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "aliases": {"type": "array", "items": {"type": "string"}},
                    "notes": {"type": "string"},
                    "first_page": {"type": "integer"},
                },
                "required": ["name"],
            },
        },
        "threads": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "pages": {"type": "array", "items": {"type": "integer"}},
                },
                "required": ["text"],
            },
        },
        "tags": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["synopsis", "characters", "threads", "tags"],
}


def _story_update_prompt(current_json: str, new_caps: str, contiguous: bool) -> str:
    order_note = (
        ""
        if contiguous
        else "新しく読んだページは作品の途中から順不同に抜き出したもので、"
        "現在の状態より過去の場面のこともある。時系列の組み替えは慎重に。\n"
    )
    return (
        "あなたは漫画を読み進めながら『物語の状態』を JSON で保守する編集者です。\n"
        f"現在の状態:\n{current_json}\n\n"
        f"新しく読んだページ:\n{new_caps}\n\n"
        f"{order_note}"
        "上記を反映して状態を更新してください。既存のキャラクターは消さずに"
        "追記・修正し、同一人物や重複する項目は統合すること。"
        "synopsis は作品全体を3〜5文で。characters は主要人物を優先して20人程度までとし、"
        "人物ごとに name / aliases(呼び名・別名があれば) / notes(外見・立場・関係) / "
        "first_page(初登場ページ番号。判明している場合のみ)。"
        "threads は未回収の伏線や進行中の出来事で、text(内容) と pages(根拠となるページ番号)を持つ。"
        "回収・完結したものは削除してよい。ページ番号は捏造せず、上のキャプションに"
        "書かれた番号だけを使うこと。"
        "tags はジャンルや要素を5〜10個。\n"
        '出力は次の JSON のみ: '
        '{"synopsis":"...","characters":[{"name":"...","aliases":["..."],"notes":"...","first_page":1}],'
        '"threads":[{"text":"...","pages":[1,2]}],"tags":["...","..."]}'
    )


def _normalize_story_state(state: dict) -> dict:
    """LLM 出力の state をスキーマに沿って正規化する(型崩れ・空要素を除去)。

    threads は旧形式(文字列の配列)も受け付けて {text, pages} 形式に揃える
    (既存 DB の state を読んだときの後方互換)。
    """
    chars: list[dict] = []
    raw_chars = state.get("characters")
    if isinstance(raw_chars, list):
        for c in raw_chars:
            if not (isinstance(c, dict) and str(c.get("name") or "").strip()):
                continue
            ch: dict = {
                "name": str(c["name"]).strip(),
                "notes": str(c.get("notes") or "").strip(),
            }
            raw_aliases = c.get("aliases")
            if isinstance(raw_aliases, list):
                aliases = [str(a).strip() for a in raw_aliases if str(a).strip()]
                if aliases:
                    ch["aliases"] = aliases
            if isinstance(c.get("first_page"), int) and c["first_page"] > 0:
                ch["first_page"] = c["first_page"]
            chars.append(ch)

    threads: list[dict] = []
    raw_threads = state.get("threads")
    if isinstance(raw_threads, list):
        for t in raw_threads:
            if isinstance(t, dict):
                text = str(t.get("text") or "").strip()
                if not text:
                    continue
                th: dict = {"text": text}
                raw_pages = t.get("pages")
                if isinstance(raw_pages, list):
                    pages = sorted({p for p in raw_pages if isinstance(p, int) and p > 0})
                    if pages:
                        th["pages"] = pages
                threads.append(th)
            elif str(t).strip():
                threads.append({"text": str(t).strip()})

    def _str_list(key: str) -> list[str]:
        v = state.get(key)
        if not isinstance(v, list):
            return []
        return [str(t).strip() for t in v if str(t).strip()]

    return {
        "synopsis": str(state.get("synopsis") or "").strip(),
        "characters": chars,
        "threads": threads,
        "tags": _str_list("tags"),
    }


def _merge_story_state(old: dict, new: dict) -> dict:
    """「消さずに統合」のプログラム的ガード。

    プロンプト指示への準拠だけに頼ると、LLM が characters を出力し忘れた回に
    登場人物が全滅する。人物が大幅(半分未満)に減った場合は旧 state から名前で
    補完する。threads は回収済みの剪定を許すためガードしない。
    """
    old_chars = [c for c in (old.get("characters") or []) if isinstance(c, dict) and c.get("name")]
    new_chars = list(new.get("characters") or [])
    if len(old_chars) >= 3 and len(new_chars) * 2 < len(old_chars):
        known: set[str] = set()
        for c in new_chars:
            known.add(c.get("name", ""))
            known.update(c.get("aliases") or [])
        for c in old_chars:
            if c["name"] not in known:
                new_chars.append(c)
        new["characters"] = new_chars
    return new


def _update_story_state(
    base_url: str,
    model: str,
    state: dict,
    new_caps: list[tuple[int, str]],
    contiguous: bool = True,
) -> dict:
    """現在の状態に新しいキャプションを反映した状態を返す(テキストのみ・画像なし)。

    contiguous=False は非順次(ランダム増分・途中再分析)で、ページが順不同なことを
    プロンプトに明示する。new_caps はページ順に並べ替えてから渡す。
    """
    if not new_caps:
        return state
    cur = json.dumps(state or {}, ensure_ascii=False)
    caps = "\n".join(f"- {p + 1}ページ: {c}" for p, c in sorted(new_caps))
    out = llm.chat(
        base_url,
        [{"role": "user", "content": _story_update_prompt(cur, caps, contiguous)}],
        model=model,
        json_schema=_STORY_STATE_SCHEMA,
    )
    parsed = _parse_json(out)
    # 更新に失敗(空 / synopsis 欠落)したら既存状態を維持する。
    if not parsed or not str(parsed.get("synopsis") or "").strip():
        return state or {}
    return _merge_story_state(state or {}, _normalize_story_state(parsed))


def _rebuild_story_state(
    base_url: str,
    model: str,
    caps: list[tuple[int, str]],
    every: int,
    on_progress: Callable[[int, int], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> dict:
    """全キャプションを M 件ずつ畳み込んで状態を作り直す(あらすじのみ再生成用)。"""
    every = max(1, every)
    chunks = [caps[i : i + every] for i in range(0, len(caps), every)]
    state: dict = {}
    for i, chunk in enumerate(chunks):
        # チャンク境界で中止を確認する(あらすじ再生成でも中止を効かせる)。
        if cancel_check and cancel_check():
            raise Cancelled()
        state = _update_story_state(base_url, model, state, chunk)
        if on_progress:
            on_progress(i + 1, len(chunks))
    return state


def _aggregate_and_save(root: Path, work_id: str, base_url: str, model: str) -> tuple[str, list[str]]:
    """解析済み全ページのキャプションから、あらすじ + タグを1回で生成し保存する(従来方式)。"""
    rows = _all_page_descriptions(root, work_id)
    if not rows:
        return "", []
    captions = [d for _, d in rows]
    agg = llm.chat(
        base_url,
        [{"role": "user", "content": _aggregate_prompt(_title(root, work_id), captions)}],
        model=model,
        json_schema=_SUMMARY_SCHEMA,
    )
    parsed = _parse_json(agg)
    summary = (parsed.get("summary") or "").strip() or agg.strip()
    tags = [str(t).strip() for t in parsed.get("tags", []) if str(t).strip()]
    _save(root, work_id, summary, tags, model)
    return summary, tags


def analyze_pages(
    root: Path,
    work_id: str,
    archive_path: Path,
    base_url: str,
    pages: list[int],
    model: str = "local",
    system_prompt: str | None = None,
    context_count: int = 0,
    use_story_summary: bool = False,
    story_every: int = 5,
    sequential: bool = False,
    use_ocr: bool = True,
    cancel_check: Callable[[], bool] | None = None,
) -> dict:
    """指定ページを解析して page_analysis に保存し、あらすじ + タグを再生成する。

    - use_ocr: mokuro(manga-ocr)でセリフを抽出して text に保存し、キャプション生成の
      文脈にも添える。OCR 依存が未導入なら黙ってスキップする。
    - context_count>0: 各ページに直前 K ページの説明をテキスト文脈として添える。
    - use_story_summary: 『物語の状態』(あらすじ + 登場人物 + 伏線)を走行更新し、あらすじ生成に使う。
    - sequential: 先頭から末尾へ順に解析する全ページパスか。True のときだけページ解析に
      走行 state(過去のみ = causal)を前置きする。ランダム増分や途中ページ再分析(sequential=False)
      では、完成済み state を渡すと「未来リーク」するため、代わりに直前 K(causal)を前置きする。
      詳細は docs/design/analysis-story-state.md「時系列と未来リーク」を参照。
    """
    total = len(pages) + 1
    set_progress(work_id, 0, total, "caption")
    summary = ""
    tags: list[str] = []
    # 順次フルパスは先頭から state を作り直す(既存の完成 state を読むと表紙が結末を知ってしまう)。
    story_causal = use_story_summary and sequential
    state: dict = {} if story_causal else (_get_story_state(root, work_id) if use_story_summary else {})
    # 非順次(再分析/ランダム)の story モードでのページ文脈は、causal な直前 K を使う。
    # story_every 由来の K には上限を設ける(生キャプション前置きは K で線形に膨らむため)。
    causal_k = max(context_count, min(story_every, _CAUSAL_K_MAX)) if use_story_summary else context_count
    # provenance: どの文脈モードでキャプションを生成したかを page_analysis に残す。
    context_mode = "story_state" if story_causal else ("prev_k" if causal_k > 0 else "none")
    pending_caps: list[tuple[int, str]] = []
    try:
        # 1) 指定ページのキャプションを保存。
        for n, idx in enumerate(pages):
            if cancel_check and cancel_check():
                raise Cancelled()
            raw, _ = archive.read_page(archive_path, idx)
            # OCR は CPU で走るため、GPU の LLM 推論とは競合しない。
            # 初回はモデルのロード(+ダウンロード)で時間がかかるので phase を分けて見せる。
            ocr_text: str | None = None
            if use_ocr:
                set_progress(work_id, n, total, "ocr")
                ocr_text = ocr.extract_text(raw)
                set_progress(work_id, n, total, "caption")
            msgs: list[dict] = []
            if system_prompt:
                msgs.append({"role": "system", "content": system_prompt})
            if story_causal:
                # 順次フル: これまで(＝そのページより前)に組み上げた状態だけを前置き。
                ctx_block = _story_context_block(state)
            else:
                # それ以外: 直前 K ページ(causal)を前置き。未来を参照しない。
                ctx_block = _prev_context_block(root, work_id, idx, causal_k)
            page_prompt = _PAGE_PROMPT_WITH_OCR if ocr_text else _PAGE_PROMPT
            text = "\n\n".join(p for p in (ctx_block, _ocr_block(ocr_text), page_prompt) if p)
            msgs.append(llm.image_message(text, _data_url(raw)))
            caption = llm.chat(base_url, msgs, model=model).strip()
            _save_page(root, work_id, idx, caption, ocr_text, model, context_mode)

            # M ページごとに物語の状態を走行更新する(画像なしの軽い呼び出し)。
            if use_story_summary:
                pending_caps.append((idx, caption))
                if len(pending_caps) >= max(1, story_every):
                    state = _update_story_state(
                        base_url, model, state, pending_caps, contiguous=sequential
                    )
                    # 順次フルパスは空から作り直すため、途中保存すると完成済み state を
                    # 半端な state で上書きしてしまう(キャンセル/クラッシュで消失、
                    # 実行中のチャットも序盤しか知らない state を読む)。完了時のみ保存する。
                    if not sequential:
                        _save_story_state(root, work_id, state, model)
                    pending_caps = []
            set_progress(work_id, n + 1, total, "caption")

        # 2) あらすじ + タグを再生成。要約フェーズ入口でも中止を確認する
        # (summary_only はページループを通らないため、ここが最初の確認点になる)。
        if cancel_check and cancel_check():
            raise Cancelled()
        set_progress(work_id, len(pages), total, "summary")
        if use_story_summary:
            if not pages:
                # あらすじのみ再生成: 全キャプションから状態を作り直す。
                state = _rebuild_story_state(
                    base_url,
                    model,
                    _all_page_descriptions(root, work_id),
                    story_every,
                    on_progress=lambda cur, tot: set_progress(work_id, cur, tot, "summary"),
                    cancel_check=cancel_check,
                )
            elif pending_caps:
                state = _update_story_state(
                    base_url, model, state, pending_caps, contiguous=sequential
                )
                pending_caps = []
            _save_story_state(root, work_id, state, model)
            summary = (state.get("synopsis") or "").strip()
            tags = [str(t).strip() for t in (state.get("tags") or []) if str(t).strip()]
            if summary:
                _save(root, work_id, summary, tags, model)
            else:
                # 状態が空なら従来の集約にフォールバック。
                summary, tags = _aggregate_and_save(root, work_id, base_url, model)
        else:
            summary, tags = _aggregate_and_save(root, work_id, base_url, model)
        set_progress(work_id, total, total, "summary")
    finally:
        clear_progress(work_id)

    return {"analyzed": pages, "summary": summary, "tags": tags, "story_state": state}


def _save(root: Path, work_id: str, summary: str, tags: list[str], model: str) -> None:
    with connect(root) as conn:
        conn.execute(
            """
            INSERT INTO analysis (work_id, summary, status, model, created_at)
            VALUES (?, ?, 'done', ?, ?)
            ON CONFLICT(work_id) DO UPDATE SET
                summary = excluded.summary,
                status = excluded.status,
                model = excluded.model,
                created_at = excluded.created_at
            """,
            (work_id, summary, model, _now()),
        )
        # 生成タグを work_tags にマージ(既存タグ UI と共用)。
        for name in tags:
            conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (name,))
            tag_id = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()["id"]
            conn.execute(
                "INSERT OR IGNORE INTO work_tags (work_id, tag_id) VALUES (?, ?)",
                (work_id, tag_id),
            )
        # 全文検索インデックスを更新(あらすじ + ページ説明を反映)。
        search.update_index(conn, work_id)
        conn.commit()


def get_analysis(root: Path, work_id: str) -> dict | None:
    with connect(root) as conn:
        row = conn.execute(
            "SELECT summary, story_state, status, model, created_at FROM analysis WHERE work_id = ?",
            (work_id,),
        ).fetchone()
    if not row:
        return None
    result = dict(row)
    # story_state は JSON テキストで保持。パースして dict(無ければ None)で返す。
    raw = result.pop("story_state", None)
    story: dict | None = None
    if raw:
        try:
            v = json.loads(raw)
            if isinstance(v, dict):
                story = v
        except json.JSONDecodeError:
            pass
    result["story_state"] = story
    return result


# ---- 作品チャット(リーダー横のチャットウィンドウ用)------------------------

_CHAT_SYSTEM = (
    "あなたは漫画作品について読者の質問に答えるアシスタントです。"
    "以下の作品情報を踏まえ、日本語で簡潔に答えてください。"
    "作品情報に無いことは推測であると断ったうえで述べ、断定しすぎないこと。"
)


def _story_state_text(state: dict) -> str:
    """物語の状態を、チャット system プロンプトに埋め込むテキストに整形する。"""
    parts: list[str] = []
    syn = (state.get("synopsis") or "").strip()
    if syn:
        parts.append(f"あらすじ:\n{syn}")
    chars = state.get("characters") or []
    if isinstance(chars, list) and chars:
        lines = "\n".join(
            f"- {_char_label(c)}" for c in chars if isinstance(c, dict) and c.get("name")
        )
        if lines:
            parts.append(f"登場人物:\n{lines}")
    threads = state.get("threads") or []
    if isinstance(threads, list) and threads:
        items: list[str] = []
        for t in threads:
            if not (isinstance(t, dict) and str(t.get("text") or "").strip()):
                continue
            pages = t.get("pages") or []
            ref = f"(p.{', '.join(str(p) for p in pages)})" if pages else ""
            items.append(f"- {t['text']}{ref}")
        if items:
            parts.append("伏線・進行中の出来事:\n" + "\n".join(items))
    return "\n\n".join(parts)


def _build_chat_messages(
    root: Path,
    work_id: str,
    messages: list[dict],
    current_page: int | None,
    archive_path: Path | None,
    include_image: bool,
    page_focus: bool = False,
    system_prompt: str | None = None,
) -> list[dict]:
    """作品情報を system に、会話履歴を並べた LLM メッセージ列を組む。

    - system_prompt: チャットの基本人格(空/None なら既定 _CHAT_SYSTEM)。
    - page_focus=True: 作品全体の情報を踏まえつつ、現在ページの場面を中心に答えさせる。
    - include_image=True かつ最後がユーザー発言なら、現在ページ画像を添える。
    """
    state = _get_story_state(root, work_id)
    ctx: list[str] = [f"作品タイトル: {_title(root, work_id)}"]
    st = _story_state_text(state)
    if st:
        ctx.append(st)
    else:
        # story_state(構造化まとめ)が無ければ、従来のあらすじ(analysis.summary)を使う。
        a = get_analysis(root, work_id)
        summ = (a.get("summary") or "").strip() if a else ""
        if summ:
            ctx.append(f"あらすじ:\n{summ}")
    focus = (system_prompt or "").strip() or _CHAT_SYSTEM
    if page_focus and current_page is not None:
        ctx.append(f"読者が今開いているページ: {current_page + 1}ページ目")
        cap = get_page_analysis(root, work_id, current_page)
        if cap and (cap.get("description") or "").strip():
            ctx.append(f"現在ページの内容: {cap['description']}")
        if cap and (cap.get("text") or "").strip():
            ctx.append(f"現在ページのセリフ(OCR):\n{cap['text']}")
        focus += (
            "\n読者はこの現在ページについて尋ねています。作品全体の文脈を踏まえつつ、"
            "回答は現在ページの場面を中心に組み立ててください。"
        )

    llm_messages: list[dict] = [{"role": "system", "content": focus + "\n\n" + "\n\n".join(ctx)}]
    last = len(messages) - 1
    for i, m in enumerate(messages):
        role = m.get("role", "user")
        content = m.get("content", "")
        attach = (
            i == last
            and role == "user"
            and include_image
            and archive_path is not None
            and current_page is not None
        )
        if attach:
            raw, _ = archive.read_page(archive_path, current_page)
            llm_messages.append(llm.image_message(content, _data_url(raw)))
        else:
            llm_messages.append({"role": role, "content": content})
    return llm_messages


def chat_about_work(
    root: Path,
    work_id: str,
    base_url: str,
    messages: list[dict],
    current_page: int | None = None,
    archive_path: Path | None = None,
    include_image: bool = False,
    page_focus: bool = False,
    system_prompt: str | None = None,
    model: str = "local",
    think: bool | None = None,
) -> str:
    """作品情報(あらすじ+登場人物+伏線)を文脈に、会話履歴へ応答する(非ストリーム)。"""
    llm_messages = _build_chat_messages(
        root, work_id, messages, current_page, archive_path, include_image, page_focus, system_prompt
    )
    return llm.chat(base_url, llm_messages, model=model, think=think)


def chat_about_work_stream(
    root: Path,
    work_id: str,
    base_url: str,
    messages: list[dict],
    current_page: int | None = None,
    archive_path: Path | None = None,
    include_image: bool = False,
    page_focus: bool = False,
    system_prompt: str | None = None,
    model: str = "local",
    think: bool | None = None,
):
    """chat_about_work のストリーム版。差分 dict を順に yield する。"""
    llm_messages = _build_chat_messages(
        root, work_id, messages, current_page, archive_path, include_image, page_focus, system_prompt
    )
    yield from llm.chat_stream(base_url, llm_messages, model=model, think=think)


# ---- 質問候補(チャット末尾のチップに混ぜる、状況に合った質問)----------------

_QUESTIONS_SCHEMA = {
    "type": "object",
    "properties": {
        "questions": {
            "type": "array",
            "minItems": 1,
            "maxItems": 3,
            "items": {"type": "string", "minLength": 6, "maxLength": 60},
        }
    },
    "required": ["questions"],
}

# 候補作りに渡す直近の往復数。多くしても候補は良くならず、待ち時間だけ伸びる。
SUGGEST_HISTORY_TURNS = 2
# 現在ページの OCR は候補作りには要点だけあればよいので頭を切って渡す。
SUGGEST_OCR_CHARS = 400


def _recent_exchanges(messages: list[dict], turns: int) -> list[str]:
    """会話履歴から発言だけを取り出して末尾 turns 往復分にする。"""
    lines: list[str] = []
    for m in messages:
        content = (m.get("content") or "").strip()
        if not content:
            continue
        if m.get("role") == "user":
            lines.append(f"読者: {content}")
        elif m.get("role") == "assistant":
            lines.append(f"アシスタント: {content}")
    return lines[-(turns * 2) :]


def suggest_chat_questions(
    root: Path,
    work_id: str,
    base_url: str,
    messages: list[dict] | None = None,
    current_page: int | None = None,
    model: str = "local",
) -> list[str]:
    """いまの作品・ページ・直近の会話を踏まえた質問候補を最大 3 件作る。

    チャット末尾の候補チップに、固定の定番質問と混ぜて並べるためのもの。
    画像もツールも使わない軽い 1 回の呼び出しで、作れなければ空を返す
    (呼び出し側は固定の候補だけを出す)。
    """
    ctx: list[str] = [f"作品タイトル: {_title(root, work_id)}"]
    st = _story_state_text(_get_story_state(root, work_id))
    if st:
        ctx.append(st)
    else:
        a = get_analysis(root, work_id)
        summ = (a.get("summary") or "").strip() if a else ""
        if summ:
            ctx.append(f"あらすじ:\n{summ}")
    if current_page is not None:
        ctx.append(f"読者が今開いているページ: {current_page + 1}ページ目")
        cap = get_page_analysis(root, work_id, current_page)
        if cap and (cap.get("description") or "").strip():
            ctx.append(f"現在ページの内容: {cap['description']}")
        ocr = (cap.get("text") or "").strip() if cap else ""
        if ocr:
            ctx.append(f"現在ページのセリフ(OCR):\n{ocr[:SUGGEST_OCR_CHARS]}")
    # 作品情報が題名しか無い(未解析)なら、固有名詞の入った候補は作れない。
    if len(ctx) <= 1:
        return []

    parts = [
        "以下は読者がいま読んでいる漫画の情報です。",
        "この読者が続けて聞きたくなる質問を3つ作ってください。",
        "",
        "条件:",
        "- 読者がアシスタント(あなた)に投げる文として書く。30字以内、日本語、疑問文または依頼文",
        "- 作品の固有名詞(人物名・場所・出来事)を使い、この作品にしか当てはまらない内容にする",
        "- 一般論(「テーマは何ですか」など)や、すでに答えの出ている質問は避ける",
        "- 3つは互いに違う切り口にする(人物 / 関係 / 伏線 / いまの場面 / この先の展開 など)",
        "",
        "## 作品情報",
        *ctx,
    ]
    recent = _recent_exchanges(messages or [], SUGGEST_HISTORY_TURNS)
    if recent:
        parts += ["", "## 直近の会話(この続きとして自然な質問にする)", *recent]

    # 候補は多少ばらけたほうが役に立つので、解析より温度を上げる。
    text = llm.chat(
        base_url,
        [{"role": "user", "content": "\n".join(parts)}],
        model=model,
        timeout=120.0,
        temperature=0.9,
        think=False,
        json_schema=_QUESTIONS_SCHEMA,
    )
    data = _parse_json(text)
    questions = [
        q.strip() for q in (data.get("questions") or []) if isinstance(q, str) and q.strip()
    ]
    return questions[:3]
