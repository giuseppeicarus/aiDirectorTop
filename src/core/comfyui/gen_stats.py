"""
Track ComfyUI generation timing and compute rolling averages.

Stats are stored as newline-delimited JSON in:
  ~/.cinematic-studio/gen_stats.jsonl

Each entry:
  {kind, workflow, width, height, steps, duration_sec, elapsed_sec, node, timestamp}

Rolling average uses the last 10 entries per (kind, workflow_key).
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Optional

STATS_FILE = Path("~/.cinematic-studio/gen_stats.jsonl").expanduser()
_WINDOW = 10  # rolling window size


def record(
    kind: str,              # "image" | "video"
    workflow: str,          # workflow id/name
    elapsed_sec: float,
    width: int = 0,
    height: int = 0,
    steps: int = 0,
    duration_sec: float = 0.0,  # for video clips
    node: str = "",
) -> None:
    entry = {
        "kind": kind,
        "workflow": workflow,
        "elapsed_sec": round(elapsed_sec, 2),
        "width": width,
        "height": height,
        "steps": steps,
        "duration_sec": round(duration_sec, 2),
        "node": node,
        "timestamp": time.time(),
    }
    STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(STATS_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def _load_all() -> list[dict]:
    if not STATS_FILE.exists():
        return []
    entries = []
    for line in STATS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except Exception:
            pass
    return entries


def get_averages() -> dict:
    """
    Returns rolling averages grouped by (kind, workflow).
    {
      "image": { "<workflow>": {avg_sec, count, avg_width, avg_height, avg_steps} },
      "video": { "<workflow>": {avg_sec, count, avg_width, avg_height, avg_duration_sec} },
    }
    """
    entries = _load_all()
    buckets: dict[tuple, list[dict]] = {}
    for e in entries:
        key = (e.get("kind", "image"), e.get("workflow", "unknown"))
        buckets.setdefault(key, []).append(e)

    result: dict[str, dict] = {"image": {}, "video": {}}
    for (kind, wf), items in buckets.items():
        window = items[-_WINDOW:]
        avg_sec = sum(i["elapsed_sec"] for i in window) / len(window)
        avg: dict = {
            "avg_sec": round(avg_sec, 1),
            "count": len(items),
            "samples": len(window),
        }
        if kind == "image":
            avg["avg_steps"] = round(sum(i.get("steps", 0) for i in window) / len(window), 0)
            avg["avg_width"] = round(sum(i.get("width", 0) for i in window) / len(window))
            avg["avg_height"] = round(sum(i.get("height", 0) for i in window) / len(window))
        else:
            avg["avg_duration_sec"] = round(sum(i.get("duration_sec", 0) for i in window) / len(window), 1)
            avg["avg_width"] = round(sum(i.get("width", 0) for i in window) / len(window))
            avg["avg_height"] = round(sum(i.get("height", 0) for i in window) / len(window))

        if kind not in result:
            result[kind] = {}
        result[kind][wf] = avg

    return result


def estimate_seconds(kind: str, workflow: str) -> Optional[float]:
    """Quick lookup: average elapsed seconds for given kind+workflow, or None."""
    avgs = get_averages()
    return avgs.get(kind, {}).get(workflow, {}).get("avg_sec")


def get_node_averages() -> dict:
    """
    Returns rolling averages grouped by (node, kind).

    {
      "NodeName": {
        "image": {"avg_sec": X, "count": N, "samples": K},
        "video": {"avg_sec": X, "count": N, "samples": K},
      },
      ...
    }
    """
    entries = _load_all()
    buckets: dict[tuple, list[dict]] = {}
    for e in entries:
        node = e.get("node") or "default"
        kind = e.get("kind", "image")
        buckets.setdefault((node, kind), []).append(e)

    result: dict = {}
    for (node, kind), items in buckets.items():
        window = items[-_WINDOW:]
        avg_sec = sum(i["elapsed_sec"] for i in window) / len(window)
        result.setdefault(node, {})[kind] = {
            "avg_sec": round(avg_sec, 1),
            "count": len(items),
            "samples": len(window),
        }
    return result


def best_node_averages() -> dict:
    """
    Returns the best per-kind averages across all nodes (node with most samples).
    {"image": avg_sec or None, "video": avg_sec or None, "node": name or None}
    """
    node_avgs = get_node_averages()
    best: dict = {"image": None, "video": None, "node": None}
    best_samples = -1
    for node, kinds in node_avgs.items():
        total_samples = sum(k.get("samples", 0) for k in kinds.values())
        if total_samples > best_samples:
            best_samples = total_samples
            best["node"] = node
            best["image"] = (kinds.get("image") or {}).get("avg_sec")
            best["video"] = (kinds.get("video") or {}).get("avg_sec")
    return best
