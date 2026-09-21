"""本のチャット(リーダー横のチャットウィンドウ)。

system には本の情報、読み終えた章の要約、質問に近い本文(本文検索)、今のページ付近の本文を入れる。
どれも「今開いているページまで」に限り、先の内容は渡さない(ネタバレ防止)。
"""

from __future__ import annotations

import base64
import io
from pathlib import Path

from PIL import Image

from . import archive, embedding, llm, structure, transcribe
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
        done = transcribe.done_pages(root, work_id)
    except transcribe.TranscribeError:
        return [], None, None
    pages = [p for p in done if current_page is None or p <= current_page]
    # ページをまたいで切れた段落はつなぐ(先のページは渡していないので持ち込まない)。
    texts = transcribe.join_pages(
        root, work_id, {p: transcribe.read_text(root, work_id, p) or "" for p in pages}
    )
    picked: list[tuple[int, str]] = []
    used = 0
    for p in reversed(pages):
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
) -> list[str]:
    """最後の質問に近い本文のまとまりを、読んだ範囲(今のページまで)から探して並べる。

    今のページ付近として別に渡すページ(exclude_pages)は除く。索引が無い・検索に失敗した
    ときは空(会話は続ける)。
    """
    if search_opts is None or budget <= 0:
        return []
    question = next(
        (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), ""
    )
    if not question.strip():
        return []
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
        return []
    out: list[str] = []
    used = 0
    for h in hits:
        text = f"--- p.{h['page'] + 1} ---\n{h['text']}"
        if out and used + len(text) > budget:
            break
        out.append(text)
        used += len(text)
    return out


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
) -> list[dict]:
    """本の情報と本文(読んだ範囲)を system に、会話履歴を並べた LLM メッセージ列を組む。

    - system_prompt: チャットの基本人格(空/None なら既定 _CHAT_SYSTEM)。
    - page_focus=True: 本文を踏まえつつ、現在ページの内容を中心に答えさせる。
    - include_image=True かつ最後がユーザー発言なら、現在ページ画像を添える(Vision モデルのみ)。
    - context_chars: 本文を渡す上限(文字数)。None なら CHAT_CONTEXT_CHARS。
    - search_opts: {server_path, models_dir}。本文検索の索引があれば、質問に近い本文を
      読んだ範囲から探して加える(予算の 1/4 まで)。無ければ検索しない。
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
    # 質問に近い本文(検索)の分を先に取り分けておく。
    search_budget = budget // 4 if search_opts is not None else 0
    body, first, last = _reading_context(root, work_id, current_page, budget - search_budget)
    found = _search_context(
        root, work_id, messages, current_page, search_opts, search_budget,
        set(range(first, last + 1)) if body else set(),
    )
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
    context_chars: int | None = None,
    search_opts: dict | None = None,
) -> str:
    """本の情報と本文(読んだ範囲)を文脈に、会話履歴へ応答する(非ストリーム)。"""
    llm_messages = _build_chat_messages(
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
    context_chars: int | None = None,
    search_opts: dict | None = None,
):
    """chat_about_work のストリーム版。差分 dict を順に yield する。"""
    llm_messages = _build_chat_messages(
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
