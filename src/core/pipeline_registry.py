"""Track active pipeline runs and persist audit log."""
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

AUDIT_FILE = Path("~/.cinematic-studio/pipeline_audit.jsonl").expanduser()

_active: Dict[str, dict] = {}


def register_run(project_id: str, project_title: str, run_id: str) -> None:
    _active[project_id] = {
        "run_id": run_id,
        "project_id": project_id,
        "project_title": project_title,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "running",
        "stage": "starting",
        "progress": 0.0,
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
