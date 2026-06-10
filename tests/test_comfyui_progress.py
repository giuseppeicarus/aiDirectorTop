import asyncio

import pytest

from src.core.comfyui.progress import bind_comfy_progress_queue


@pytest.mark.asyncio
async def test_stage_progress_does_not_emit_sampling_percent():
    q, callback = bind_comfy_progress_queue(label="Immagine")

    callback(1, 1, "LoadImage")

    event = await asyncio.wait_for(q.get(), timeout=1)
    assert event["progress_kind"] == "stage"
    assert "comfyui_pct" not in event
    assert event["comfyui_node"] == "LoadImage"


@pytest.mark.asyncio
async def test_sampling_progress_emits_real_step_percent():
    q, callback = bind_comfy_progress_queue(label="Immagine")

    callback(5, 25, "KSampler")

    event = await asyncio.wait_for(q.get(), timeout=1)
    assert event["comfyui_value"] == 5
    assert event["comfyui_max"] == 25
    assert event["comfyui_pct"] == 20.0

