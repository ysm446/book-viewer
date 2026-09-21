"""管理ルートごとの SQLite (library.db) アクセス。

接続はリクエストごとに開いて閉じる方針(uvicorn のスレッドプール実行に合わせる)。
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import db_path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS works (
    id              TEXT PRIMARY KEY,           -- 内容フィンガープリント
    rel_path        TEXT NOT NULL,              -- ルートからの相対パス(本フォルダ内の元アーカイブ)
    title           TEXT NOT NULL,
    author          TEXT NOT NULL DEFAULT '',
    writing_mode    TEXT NOT NULL DEFAULT 'horizontal',  -- 'horizontal' / 'vertical'(本文の書字方向)
    page_count      INTEGER NOT NULL,
    page_direction  TEXT NOT NULL DEFAULT 'default',  -- 'default'(グローバル設定に従う) / 'rtl' / 'ltr'
    spread_offset   TEXT NOT NULL DEFAULT 'default',  -- 見開きのペア境界ずらし: 'default' / '0' / '1'
    sort_index      INTEGER,                          -- 手動並び替えの位置(NULL = 未設定)
    added_at        TEXT NOT NULL,
    last_opened_at  TEXT
);

CREATE TABLE IF NOT EXISTS reading_state (
    work_id     TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
    last_page   INTEGER NOT NULL DEFAULT 0,
    completed   INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    work_id     TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    page        INTEGER NOT NULL,
    note        TEXT,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS work_tags (
    work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (work_id, tag_id)
);

CREATE TABLE IF NOT EXISTS analysis (
    work_id     TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
    summary     TEXT,
    story_state TEXT,   -- 物語の走行状態(JSON): {synopsis, characters[], threads[], tags[]}
    status      TEXT NOT NULL DEFAULT 'none',
    model       TEXT,
    created_at  TEXT
);

CREATE TABLE IF NOT EXISTS page_analysis (
    work_id      TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    page         INTEGER NOT NULL,
    description  TEXT,
    text         TEXT,
    model        TEXT,
    context_mode TEXT,   -- キャプション生成時の文脈: story_state / prev_k / none
    created_at   TEXT NOT NULL,
    PRIMARY KEY (work_id, page)
);
"""


def _migrate(conn: sqlite3.Connection) -> None:
    """既存 DB へ後から追加された列を補う。"""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(works)").fetchall()}
    if "spread_offset" not in cols:
        conn.execute(
            "ALTER TABLE works ADD COLUMN spread_offset TEXT NOT NULL DEFAULT 'default'"
        )
    if "sort_index" not in cols:
        conn.execute("ALTER TABLE works ADD COLUMN sort_index INTEGER")
    if "author" not in cols:
        conn.execute("ALTER TABLE works ADD COLUMN author TEXT NOT NULL DEFAULT ''")
    if "writing_mode" not in cols:
        conn.execute(
            "ALTER TABLE works ADD COLUMN writing_mode TEXT NOT NULL DEFAULT 'horizontal'"
        )
    acols = {row["name"] for row in conn.execute("PRAGMA table_info(analysis)").fetchall()}
    if acols and "story_state" not in acols:
        conn.execute("ALTER TABLE analysis ADD COLUMN story_state TEXT")
    pcols = {row["name"] for row in conn.execute("PRAGMA table_info(page_analysis)").fetchall()}
    if pcols and "context_mode" not in pcols:
        conn.execute("ALTER TABLE page_analysis ADD COLUMN context_mode TEXT")


def _init_search(conn: sqlite3.Connection) -> None:
    """全文検索用の FTS5 索引(trigram)。未対応環境では作らない(LIKE で代替)。"""
    try:
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS search_index "
            "USING fts5(work_id UNINDEXED, content, tokenize='trigram')"
        )
    except sqlite3.OperationalError:
        pass


def _init(conn: sqlite3.Connection) -> None:
    conn.executescript(_SCHEMA)
    _migrate(conn)
    _init_search(conn)
    # 読み書きの並行性を上げる(スキャン中の長い書き込みで他が固まらないように)。
    # WAL はデータベース単位で永続化されるが、毎回実行しても害はない。
    conn.execute("PRAGMA journal_mode = WAL")
    conn.commit()


# スキーマ作成・マイグレーションは db ファイルごとにプロセス内で一度だけ行う
# (毎リクエストの DDL / PRAGMA 実行は無駄な固定費になる)。
_initialized: set[str] = set()
_init_lock = threading.Lock()


@contextmanager
def connect(root: Path) -> Iterator[sqlite3.Connection]:
    """ルートの library.db へ接続する。スキーマが無ければ作成する。"""
    path = db_path(root)
    # busy timeout を長めに取り、スキャン等の書き込み中でも待って続行できるようにする。
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        key = str(path)
        if key not in _initialized:
            with _init_lock:
                if key not in _initialized:
                    _init(conn)
                    _initialized.add(key)
        yield conn
    finally:
        conn.close()
