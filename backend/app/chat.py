"""本のチャット(リーダー横のチャットウィンドウ)。

system には本の情報、読み終えた章の要約、質問の語が出てくる本文(キーワード検索)、
質問に近い本文(本文検索)、今のページ付近の本文を入れる。
どれも「今開いているページまで」に限り、先の内容は渡さない(ネタバレ防止)。
"""

from __future__ import annotations

import base64
import io
import math
import re
from pathlib import Path

from PIL import Image

from . import archive, content, embedding, llm, structure, transcribe
from .db import connect

# 画像を添えるときに縮小する長辺(コスト削減)。
_IMAGE_MAX = 1024


def _data_url(raw: bytes) -> str:
    """ページ画像バイト列を縮小 JPEG にして data URL 化する。"""
    with Image.open(io.BytesIO(raw)) as img:
        img = img.convert("RGB")
        img.thumbnail((_IMAGE_MAX, _IMAGE_MAX))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=85)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


# ---- 本のチャット --------------------------------------------------

_CHAT_SYSTEM = (
    "あなたは、読者がいま読んでいる本について質問に答える読書アシスタントです。"
    "以下の「本の情報」と「本文」(読者が読んだ範囲)を根拠に、日本語で簡潔に答えてください。"
    "本文を根拠にするときは、どのページか(p.○)を添えてください。"
    "本文に書かれていないことは、推測や一般的な知識であると断ったうえで述べ、断定しすぎないこと。"
    "読者がまだ読んでいない先の内容(結末や種明かしなど)には触れないでください。"
)

# チャットに渡す本文の既定の上限(文字数)。コンテキスト長が分かれば呼び出し側が調整する。
CHAT_CONTEXT_CHARS = 12000


def _reading_context(
    root: Path, work_id: str, current_page: int | None, budget: int
) -> tuple[list[str], int | None, int | None]:
    """読者が読んだ範囲(現在ページまで)の本文を、現在ページに近い順に budget 文字まで集める。

    戻り値は (ページ番号順に並んだ「--- p.N ---」付きの本文, 最初のページ, 最後のページ)。
    本文が無ければ ([], None, None)。先のページは渡さない(ネタバレ防止)。
    """
    try:
        # アプリ用の本文(ページをまたいで切れた段落はつないである)。先のページの文は持ち込まない。
        texts = content.page_texts(root, work_id, max_page=current_page)
    except transcribe.TranscribeError:
        return [], None, None
    picked: list[tuple[int, str]] = []
    used = 0
    for p in sorted(texts, reverse=True):
        text = transcribe.plain_for_llm(texts[p])
        if not text:
            continue
        if picked and used + len(text) > budget:
            break
        picked.append((p, text))
        used += len(text)
    if not picked:
        return [], None, None
    picked.reverse()
    return [f"--- p.{p + 1} ---\n{t}" for p, t in picked], picked[0][0], picked[-1][0]


def _read_chapters(
    root: Path, work_id: str, current_page: int | None, budget: int
) -> tuple[list[str], str | None]:
    """読み終えた章(今のページより前で終わる章)の要約と、今読んでいる章の題名。

    要約は今のページに近い章から budget 文字まで。先の章と本全体の要約は入れない(ネタバレ防止)。
    章立てが無ければ ([], None)。
    """
    try:
        chapters = structure.get_structure(root, work_id)["chapters"]
    except Exception:  # noqa: BLE001 - 章立ては補助情報なので、読めなくても会話は続ける
        return [], None
    if current_page is None:
        return [], None
    current = next((c["title"] for c in chapters if c["start"] <= current_page <= c["end"]), None)
    picked: list[str] = []
    used = 0
    for c in reversed([c for c in chapters if c["end"] < current_page and c.get("summary")]):
        text = f"### {c['title']}(p.{c['start'] + 1}〜p.{c['end'] + 1})\n{c['summary']}"
        if picked and used + len(text) > budget:
            break
        picked.append(text)
        used += len(text)
    picked.reverse()
    return picked, current


def _search_context(
    root: Path,
    work_id: str,
    messages: list[dict],
    current_page: int | None,
    search_opts: dict | None,
    budget: int,
    exclude_pages: set[int],
) -> tuple[list[str], list[int]]:
    """最後の質問に近い本文のまとまりを、読んだ範囲(今のページまで)から探して並べる。

    今のページ付近やキーワード検索で別に渡すページ(exclude_pages)は除く。索引が無い・検索に
    失敗したときは空(会話は続ける)。戻り値は (本文, 使ったページ)。
    """
    if search_opts is None or budget <= 0:
        return [], []
    question = _last_question(messages)
    if not question.strip():
        return [], []
    try:
        hits = embedding.search(
            root,
            work_id,
            question,
            search_opts.get("server_path"),
            search_opts.get("models_dir"),
            max_page=current_page,
            exclude_pages=exclude_pages,
        )
    except Exception:  # noqa: BLE001 - 検索は補助なので、失敗しても会話は止めない
        return [], []
    out: list[str] = []
    pages: list[int] = []
    used = 0
    for h in hits:
        text = f"--- p.{h['page'] + 1} ---\n{h['text']}"
        if out and used + len(text) > budget:
            break
        out.append(text)
        pages.append(h["page"])
        used += len(text)
    return out, pages


# ---- キーワード検索(質問の語が文字どおり出てくるページ) --------------------------
# ベクトル検索は意味の近さには強いが、山の名前・人名などの固有名詞を取りこぼしやすい。
# 索引が無くても動くよう、読んだ範囲の本文から質問の語をそのまま探して補う。

# 質問から拾う語: 「」『』で囲んだ語、漢字の連なり、カタカナの連なり、英数字の連なり(いずれも 2 文字以上)。
_QUOTED_RE = re.compile(r"[「『]([^」』]{2,30})[」』]")
_TERM_RE = re.compile(
    r"[一-鿿㐀-䶿々〆ヵヶ]{2,}"
    r"|[ァ-ヺー]{2,}"
    r"|[A-Za-z0-9][A-Za-z0-9\-]+"
    r"|[Ａ-Ｚａ-ｚ０-９]{2,}"
)
# 質問によく出るが、本文を探す手がかりにならない語。
_STOP_TERMS = {
    "本文", "内容", "説明", "意味", "理由", "場所", "場合", "部分", "全体", "要約", "作者", "著者",
    "筆者", "本書", "今回", "最初", "最後", "前後", "以前", "以降", "具体", "具体例", "簡単", "詳細",
    "特徴", "違い", "関係", "方法", "結論", "主張", "目的", "背景", "何故", "登場人物", "人物",
    "要点", "概要", "感想", "解説", "ページ", "テーマ", "ポイント", "キーワード",
}
# 1 ページから見せる、語の前後の文字数と箇所の数。キーワード検索で拾うページの数。
_KEYWORD_WINDOW = 200
_KEYWORD_SPOTS = 2
_KEYWORD_PAGES = 4


def _question_terms(question: str) -> list[str]:
    """質問から本文を探す語を取り出す(重複なし、出てきた順)。"""
    terms = [m.group(1).strip() for m in _QUOTED_RE.finditer(question)]
    terms += [t for t in _TERM_RE.findall(question) if t not in _STOP_TERMS]
    seen: set[str] = set()
    out: list[str] = []
    for t in terms:
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _snippets(text: str, terms: list[str]) -> str:
    """本文のうち、語が出てくる箇所の前後だけを切り出す(離れた箇所は改行でつなぐ)。"""
    spots = sorted({m.start() for t in terms for m in re.finditer(re.escape(t), text)})
    spans: list[list[int]] = []
    for pos in spots:
        start, end = max(0, pos - _KEYWORD_WINDOW), min(len(text), pos + _KEYWORD_WINDOW)
        if spans and start <= spans[-1][1]:
            spans[-1][1] = max(spans[-1][1], end)
        elif len(spans) < _KEYWORD_SPOTS:
            spans.append([start, end])
    parts = [
        ("…" if s > 0 else "") + text[s:e].strip() + ("…" if e < len(text) else "") for s, e in spans
    ]
    return "\n".join(parts)


def keyword_search(
    root: Path,
    work_id: str,
    question: str,
    *,
    max_page: int | None,
    exclude_pages: set[int] | None = None,
    k: int = _KEYWORD_PAGES,
) -> list[dict]:
    """質問の語が出てくるページを、読んだ範囲(max_page まで)から k 件返す。[{page, text}] をページ順に。

    多くのページに出てくる語より、限られたページにしか出てこない語を重く見る。
    """
    terms = _question_terms(question)
    if not terms:
        return []
    try:
        texts = content.page_texts(root, work_id, max_page=max_page)
    except transcribe.TranscribeError:
        return []
    plain = {p: transcribe.plain_for_llm(t) for p, t in texts.items()}
    df = {t: sum(1 for x in plain.values() if t in x) for t in terms}
    n = max(1, len(plain))
    scored: list[tuple[float, int]] = []
    for p, text in plain.items():
        if exclude_pages and p in exclude_pages:
            continue
        score = sum(
            math.log(1 + n / df[t]) * (1 + math.log(text.count(t)))
            for t in terms
            if df[t] and t in text
        )
        if score > 0:
            scored.append((score, p))
    top = sorted(p for _, p in sorted(scored, reverse=True)[:k])
    return [{"page": p, "text": _snippets(plain[p], terms)} for p in top]


def _last_question(messages: list[dict]) -> str:
    return next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")


def _keyword_context(
    root: Path,
    work_id: str,
    messages: list[dict],
    current_page: int | None,
    budget: int,
    exclude_pages: set[int],
) -> tuple[list[str], list[int]]:
    """最後の質問の語が出てくる本文を並べる。戻り値は (本文, 使ったページ)。"""
    question = _last_question(messages)
    if not question.strip() or budget <= 0:
        return [], []
    out: list[str] = []
    pages: list[int] = []
    used = 0
    for h in keyword_search(root, work_id, question, max_page=current_page, exclude_pages=exclude_pages):
        text = f"--- p.{h['page'] + 1} ---\n{h['text']}"
        if out and used + len(text) > budget:
            break
        out.append(text)
        pages.append(h["page"])
        used += len(text)
    return out, pages


def _book_info(root: Path, work_id: str) -> list[str]:
    with connect(root) as conn:
        row = conn.execute(
            "SELECT title, author, page_count FROM works WHERE id = ?", (work_id,)
        ).fetchone()
    if row is None:
        return []
    info = [f"書名: {row['title']}"]
    if (row["author"] or "").strip():
        info.append(f"著者: {row['author']}")
    info.append(f"全 {row['page_count']} ページ")
    return info


def _build_chat_messages(
    root: Path,
    work_id: str,
    messages: list[dict],
    current_page: int | None,
    archive_path: Path | None,
    include_image: bool,
    page_focus: bool = False,
    system_prompt: str | None = None,
    context_chars: int | None = None,
    search_opts: dict | None = None,
) -> tuple[list[dict], dict]:
    """本の情報と本文(読んだ範囲)を system に、会話履歴を並べた LLM メッセージ列を組む。

    戻り値は (メッセージ列, 使った材料)。材料は画面の「参照」表示に使う
    {nearby: [最初, 最後] | None, keyword: [ページ], search: [ページ], summaries: 章の数}(ページは 0 始まり)。

    - system_prompt: チャットの基本人格(空/None なら既定 _CHAT_SYSTEM)。
    - page_focus=True: 本文を踏まえつつ、現在ページの内容を中心に答えさせる。
    - include_image=True かつ最後がユーザー発言なら、現在ページ画像を添える(Vision モデルのみ)。
    - context_chars: 本文を渡す上限(文字数)。None なら CHAT_CONTEXT_CHARS。
    - search_opts: {server_path, models_dir}。本文検索の索引があれば、質問に近い本文を
      読んだ範囲から探して加える。無ければ検索しない。
    - 質問の語が文字どおり出てくる本文(キーワード検索)はいつも探す。検索の分は予算の 1/4 までで、
      キーワード検索を先に使う(本文検索と併用するときは 6 割まで)。
    """
    focus = (system_prompt or "").strip() or _CHAT_SYSTEM
    sections = ["## 本の情報", *_book_info(root, work_id)]
    if current_page is not None:
        sections.append(f"読者が今開いているページ: p.{current_page + 1}")

    budget = context_chars if context_chars and context_chars > 0 else CHAT_CONTEXT_CHARS
    # 読み終えた章の要約に 1/3 まで、残りを今のページ付近の本文に使う。
    summaries, current_chapter = _read_chapters(root, work_id, current_page, budget // 3)
    if current_chapter:
        sections.append(f"読者が今読んでいる章: {current_chapter}")
    if summaries:
        sections += ["", "## 読み終えた章の要約", *summaries]
        budget -= sum(len(t) for t in summaries)
    # 質問の語・質問に近い本文(検索)の分を先に取り分けておく。
    search_budget = budget // 4
    body, first, last = _reading_context(root, work_id, current_page, budget - search_budget)
    nearby = set(range(first, last + 1)) if body else set()
    keyword_budget = int(search_budget * 0.6) if search_opts is not None else search_budget
    keyword, keyword_pages = _keyword_context(
        root, work_id, messages, current_page, keyword_budget, nearby
    )
    found, found_pages = _search_context(
        root,
        work_id,
        messages,
        current_page,
        search_opts,
        search_budget - sum(len(t) for t in keyword),
        nearby | set(keyword_pages),
    )
    if keyword:
        sections += ["", "## 質問の語が出てくる本文(読んだ範囲から。語の前後だけ)", *keyword]
    if found:
        sections += ["", "## 質問に関係しそうな本文(読んだ範囲から検索。ページ順ではない)", *found]
    if body:
        note = f"p.{first + 1}〜p.{last + 1}"
        if first > 0:
            note += "。これより前のページは長さの都合で省略(上の章の要約を参考に)"
        sections += ["", f"## 本文(読者が読んだ範囲のうち、今のページに近い部分: {note})", *body]
    else:
        sections += [
            "",
            "## 本文",
            "(まだ文字起こしされていないため、本文はありません。本文を根拠にした答えはできないことを"
            "読者に伝えたうえで、書名から分かる範囲・一般的な知識として答えてください。)",
        ]

    if page_focus and current_page is not None:
        focus += (
            f"\n読者はいま開いているページ(p.{current_page + 1})について尋ねています。"
            "本文全体の流れを踏まえつつ、回答はこのページの内容を中心に組み立ててください。"
        )

    llm_messages: list[dict] = [{"role": "system", "content": focus + "\n\n" + "\n".join(sections)}]
    last_i = len(messages) - 1
    for i, m in enumerate(messages):
        role = m.get("role", "user")
        content = m.get("content", "")
        attach = (
            i == last_i
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
    sources = {
        "nearby": [first, last] if body else None,
        "keyword": keyword_pages,
        "search": found_pages,
        "summaries": len(summaries),
    }
    return llm_messages, sources


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
    context_chars: int | None = None,
    search_opts: dict | None = None,
) -> tuple[str, dict]:
    """本の情報と本文(読んだ範囲)を文脈に、会話履歴へ応答する(非ストリーム)。

    戻り値は (応答, 使った材料)。材料は _build_chat_messages を参照。
    """
    llm_messages, sources = _build_chat_messages(
        root,
        work_id,
        messages,
        current_page,
        archive_path,
        include_image,
        page_focus,
        system_prompt,
        context_chars,
        search_opts,
    )
    return llm.chat(base_url, llm_messages, model=model, think=think), sources


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
    context_chars: int | None = None,
    search_opts: dict | None = None,
):
    """chat_about_work のストリーム版。差分 dict を順に yield する。

    最初に {"type": "sources", ...使った材料} を 1 回 yield してから、応答の差分を流す。
    """
    llm_messages, sources = _build_chat_messages(
        root,
        work_id,
        messages,
        current_page,
        archive_path,
        include_image,
        page_focus,
        system_prompt,
        context_chars,
        search_opts,
    )
    yield {"type": "sources", **sources}
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
# 候補作りには、今のページ付近の本文が少しあれば足りる。
SUGGEST_CONTEXT_CHARS = 3000


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
    """いまの本・ページ・直近の会話を踏まえた質問候補を最大 3 件作る。

    チャット末尾の候補チップに、固定の定番質問と混ぜて並べるためのもの。
    画像もツールも使わない軽い 1 回の呼び出しで、作れなければ空を返す
    (呼び出し側は固定の候補だけを出す)。
    """
    body, _, _ = _reading_context(root, work_id, current_page, SUGGEST_CONTEXT_CHARS)
    # 本文が無い(未文字起こし)なら、内容に即した候補は作れない。
    if not body:
        return []
    ctx = [*_book_info(root, work_id), "", *body]

    parts = [
        "以下は読者がいま読んでいる本の情報と、今のページ付近の本文です。",
        "この読者が続けて聞きたくなる質問を3つ作ってください。",
        "",
        "条件:",
        "- 読者がアシスタント(あなた)に投げる文として書く。30字以内、日本語、疑問文または依頼文",
        "- 本文に出てくる用語・人物・出来事を使い、この本のこの箇所にしか当てはまらない内容にする",
        "- 一般論(「テーマは何ですか」など)や、すでに答えの出ている質問は避ける",
        "- 3つは互いに違う切り口にする(用語の意味 / 理由・仕組み / 具体例 / 前とのつながり など)",
        "- まだ読んでいない先の内容を尋ねる質問は作らない",
        "",
        "## 本の情報と本文",
        *ctx,
    ]
    recent = _recent_exchanges(messages or [], SUGGEST_HISTORY_TURNS)
    if recent:
        parts += ["", "## 直近の会話(この続きとして自然な質問にする)", *recent]

    # 候補は多少ばらけたほうが役に立つので、温度を上げる。
    text = llm.chat(
        base_url,
        [{"role": "user", "content": "\n".join(parts)}],
        model=model,
        timeout=120.0,
        temperature=0.9,
        think=False,
        json_schema=_QUESTIONS_SCHEMA,
    )
    data = llm.parse_json(text)
    questions = [
        q.strip() for q in (data.get("questions") or []) if isinstance(q, str) and q.strip()
    ]
    return questions[:3]
