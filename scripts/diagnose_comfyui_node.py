#!/usr/bin/env python3
"""Diagnostica nodo ComfyUI (RunPod / locale) per trailer pipeline."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.core.config import get_config
from src.core.comfyui.client import ComfyUIClient
from src.core.comfyui.workflow_builder import build_txt2img_workflow
from src.core.models.cinematic import FramePrompt


async def diagnose_node(node_cfg) -> dict:
    c = ComfyUIClient(node_cfg)
    report: dict = {"name": node_cfg.name, "url": node_cfg.base_url, "primary": node_cfg.primary}

    report["alive"] = await c.is_alive()
    if not report["alive"]:
        report["error"] = "system_stats non raggiungibile"
        return report

    try:
        stats = await c.health_check()
        report["system_stats"] = {
            "devices": len(stats.get("devices", [])),
            "vram_gb": round(
                sum(d.get("vram_total", 0) for d in stats.get("devices", [])) / 1e9, 1
            ),
        }
    except Exception as e:
        report["system_stats_error"] = str(e)

    report["queue_depth"] = await c.get_queue_depth()
    report["supports_upload"] = await c.supports_upload()

    before = await c._history_prompt_ids()
    report["history_count_before"] = len(before)

    frame = FramePrompt(prompt="diagnostic test frame", negative_prompt="bad")
    wf = build_txt2img_workflow(
        frame, output_prefix="diag_probe", width=256, height=256, steps=2,
    )

    try:
        pid = await c.queue_prompt(wf)
        report["prompt_id"] = pid
        report["queue_prompt"] = "ok"
    except Exception as e:
        report["queue_prompt"] = "failed"
        report["queue_error"] = str(e)
        return report

    # Attendi 45s: WS + polling history
    try:
        hist = await c.wait_for_completion(pid, timeout=45)
        files = []
        for node_out in (hist.get("outputs") or {}).values():
            for kind in ("images", "videos", "gifs"):
                files.extend(node_out.get(kind, []))
        report["execution"] = "ok" if files else "no_outputs"
        report["output_files"] = len(files)
    except Exception as e:
        report["execution"] = "failed"
        report["execution_error"] = str(e)
        after = await c._history_prompt_ids()
        report["history_count_after"] = len(after)
        report["history_grew"] = len(after) > len(before)
        h = await c.get_history(pid)
        report["history_has_outputs"] = bool(h.get("outputs"))

    return report


async def main() -> None:
    cfg = get_config()
    nodes = [n for n in cfg.comfyui.nodes if n.enabled]
    print(f"Nodi abilitati: {len(nodes)}\n")
    for node in nodes:
        print("=" * 60)
        print(f"  {node.name}  {node.base_url}  primary={node.primary}")
        print("=" * 60)
        rep = await diagnose_node(node)
        print(json.dumps(rep, indent=2, ensure_ascii=False))
        print()


if __name__ == "__main__":
    asyncio.run(main())
