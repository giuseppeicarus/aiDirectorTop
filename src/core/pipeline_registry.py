"""Track active pipeline runs and persist audit log.

Tracks two classes of jobs:
  - 'cinematic' runs (old LLM pipeline, keyed by project_id)
  - 'reel' and 'trailer' runs (keyed by job_id)

Cancellation is supported for reel/trailer jobs that registered an asyncio.Task.
"""
import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

AUDIT_FILE = Path("~/.cinematic-studio/pipeline_audit.jsonl").expanduser()

# ── Cinematic pipeline (legacy, keyed by project_id) ─────────────────────────
_active: Dict[str, dict] = {}

# ── Reel / Trailer jobs (keyed by job_id) ────────────────────────────────────
_jobs: Dict[str, dict] = {}
_tasks: Dict[str, "asyncio.Task"] = {}
_pause_events: Dict[str, "asyncio.Event"] = {}


# ═══════════════════════════════════════════════════════════════════════════════
# Cinematic pipeline (unchanged API)
# ═══════════════════════════════════════════════════════════════════════════════

def register_run(project_id: str, project_title: str, run_id: str) -> None:
    _active[project_id] = {
        "run_id": run_id,
        "project_id": project_id,
        "project_title": project_title,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "running",
        "stage": "starting",
        "progress": 0.0,
        "kind": "cinematic",
    }


def update_run(project_id: str, stage: str, progress: float) -> None:
    if project_id in _active:
        _active[project_id].update({"stage": stage, "progress": progress})


def complete_run(
    project_id: str,
    status: str = "completed",
    error: Optional[str] = None,
    stages_done: int = 0,
) -> None:
    run = _active.pop(project_id, {})
    if not run:
        return
    entry = {
        **run,
        "status": status,
        "ended_at": datetime.now(timezone.utc).isoformat(),
        "stages_done": stages_done,
    }
    if error:
        entry["error"] = error
    _append_audit(entry)


def get_active() -> List[dict]:
    return list(_active.values())


# ═══════════════════════════════════════════════════════════════════════════════
# Reel / Trailer job registry
# ═══════════════════════════════════════════════════════════════════════════════

def register_job(
    job_id: str,
    kind: str,        # "reel" | "trailer"
    title: str,
    project_id: str,
) -> None:
    _jobs[job_id] = {
        "job_id": job_id,
        "kind": kind,
        "title": title,
        "project_id": project_id,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "running",
        "stage": "starting",
        "progress": 0.0,
        "message": "",
        "cancellable": False,   # becomes True once task is registered
        "paused": False,
    }
    ev = asyncio.Event()
    ev.set()
    _pause_events[job_id] = ev


def register_task(job_id: str, task: "asyncio.Task") -> None:
    _tasks[job_id] = task
    if job_id in _jobs:
        _jobs[job_id]["cancellable"] = True


def get_pause_event(job_id: str) -> Optional["asyncio.Event"]:
    return _pause_events.get(job_id)


def is_job_paused(job_id: str) -> bool:
    ev = _pause_events.get(job_id)
    return ev is not None and not ev.is_set()


def is_task_running(job_id: str) -> bool:
    task = _tasks.get(job_id)
    return task is not None and not task.done()


def pause_job(job_id: str) -> bool:
    ev = _pause_events.get(job_id)
    if not ev or not is_task_running(job_id):
        return False
    ev.clear()
    if job_id in _jobs:
        _jobs[job_id]["paused"] = True
        _jobs[job_id]["status"] = "paused"
    return True


def resume_job(job_id: str) -> bool:
    ev = _pause_events.get(job_id)
    if not ev:
        return False
    ev.set()
    if job_id in _jobs:
        _jobs[job_id]["paused"] = False
        _jobs[job_id]["status"] = "running"
    return True


def update_job(job_id: str, stage: str = "", progress: float = 0.0, message: str = "") -> None:
    if job_id in _jobs:
        if stage:
            _jobs[job_id]["stage"] = stage
        _jobs[job_id]["progress"] = progress
        if message:
            _jobs[job_id]["message"] = message


def complete_job(
    job_id: str,
    status: str = "completed",
    error: Optional[str] = None,
) -> None:
    job = _jobs.pop(job_id, {})
    _tasks.pop(job_id, None)
    _pause_events.pop(job_id, None)
    if not job:
        return
    entry = {
        **job,
        "status": status,
        "ended_at": datetime.now(timezone.utc).isoformat(),
        "stages_done": 0,
    }
    if error:
        entry["error"] = error
    _append_audit(entry)


def cancel_job(job_id: str) -> bool:
    """Cancel a running reel/trailer job. Returns True if task was found and cancelled."""
    task = _tasks.get(job_id)
    if task and not task.done():
        task.cancel()
        if job_id in _jobs:
            _jobs[job_id]["status"] = "cancelling"
        ev = _pause_events.get(job_id)
        if ev:
            ev.set()
        return True
    return False


def force_stop_job(job_id: str) -> dict:
    """Annulla il task asyncio se presente e rimuove la registrazione in-memory."""
    cancelled = cancel_job(job_id)
    _tasks.pop(job_id, None)
    _pause_events.pop(job_id, None)
    if job_id in _jobs:
        _jobs[job_id]["status"] = "cancelled"
        _jobs[job_id]["cancellable"] = False
        _jobs[job_id]["paused"] = False
    return {"cancelled": cancelled, "task_was_running": cancelled}


async def cancel_all_jobs() -> int:
    """Cancel and remove every active reel/trailer task."""
    tasks = [task for task in _tasks.values() if not task.done()]
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    count = len(_jobs)
    _jobs.clear()
    _tasks.clear()
    for event in _pause_events.values():
        event.set()
    _pause_events.clear()
    _active.clear()
    return count


def get_active_jobs() -> List[dict]:
    """All active reel/trailer jobs."""
    return list(_jobs.values())


# ═══════════════════════════════════════════════════════════════════════════════
# Unified view
# ═══════════════════════════════════════════════════════════════════════════════

def get_all_active() -> List[dict]:
    """All active runs — cinematic + reel + trailer — sorted by start time."""
    all_runs = list(_active.values()) + list(_jobs.values())
    all_runs.sort(key=lambda r: r.get("started_at", ""), reverse=True)
    return all_runs


# ═══════════════════════════════════════════════════════════════════════════════
# Audit log
# ═══════════════════════════════════════════════════════════════════════════════

def get_audit_log(limit: int = 200) -> List[dict]:
    if not AUDIT_FILE.exists():
        return []
    lines = AUDIT_FILE.read_text(encoding="utf-8").strip().splitlines()
    entries = []
    for line in reversed(lines):
        try:
            e = json.loads(line)
            entries.append(e)
            if len(entries) >= limit:
                break
        except Exception:
            pass
    return entries


def clear_audit_log() -> None:
    if AUDIT_FILE.exists():
        AUDIT_FILE.unlink()


def _append_audit(entry: dict) -> None:
    AUDIT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(AUDIT_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
