"""ジョブの進み具合(別スレッドから画面へ見せる)と中断。"""

from __future__ import annotations

import threading


class Cancelled(Exception):
    """ジョブが中断されたことを表す。"""


# work_id -> {current, total, phase}
_lock = threading.Lock()
_progress: dict[str, dict] = {}


def set_progress(work_id: str, current: int, total: int, phase: str) -> None:
    with _lock:
        _progress[work_id] = {"current": current, "total": total, "phase": phase}


def get_progress(work_id: str) -> dict | None:
    with _lock:
        return _progress.get(work_id)


def clear_progress(work_id: str) -> None:
    with _lock:
        _progress.pop(work_id, None)
