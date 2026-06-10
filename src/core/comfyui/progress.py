"""
Helper per progresso live ComfyUI (WebSocket sampling steps).
"""

from __future__ import annotations

import asyncio
from typing import AsyncIterator, Callable, Optional

ProgressCallback = Callable[..., None]


def bind_comfy_progress_queue(
    *,
    start: float = 0.05,
    end: float = 0.88,
    label: str = "ComfyUI",
    event: str = "progress",
    extra: Optional[dict] = None,
) -> tuple[asyncio.Queue, ProgressCallback]:
    """
    Crea coda + callback da passare a wait_for_completion / run_with_fallback.
    Mappa value/max ComfyUI → pct globale tra start e end.
    """
    q: asyncio.Queue = asyncio.Queue()
    last_key = [-1]
    base_extra = dict(extra or {})

    def callback(value: int, max_val: int, node: Optional[str] = None) -> None:
        if max_val <= 1:
            payload = {
                "event": event,
                "msg": f"{label}: {node or 'preparazione'}",
                "pct": round(start, 4),
                "comfyui_node": node,
                "progress_kind": "stage",
                **base_extra,
            }
            try:
                q.put_nowait(payload)
            except Exception:
                pass
            return

        inner = min(1.0, value / max(max_val, 1))
        pct = start + (end - start) * inner
        key = int(pct * 1000)
        if key <= last_key[0] and max_val > 1:
            return
        last_key[0] = key
        node_part = f" · {node}" if node else ""
        payload = {
            "event": event,
            "msg": f"{label} {value}/{max_val}{node_part}",
            "pct": round(pct, 4),
            "comfyui_value": value,
            "comfyui_max": max_val,
            "comfyui_node": node,
            "comfyui_pct": round(inner * 100, 1),
            **base_extra,
        }
        try:
            q.put_nowait(payload)
        except Exception:
            pass

    return q, callback


async def iter_progress_while(task: asyncio.Task, q: asyncio.Queue) -> AsyncIterator[dict]:
    """Yield eventi progress finché il task ComfyUI è in esecuzione."""
    while not task.done() or not q.empty():
        try:
            ev = await asyncio.wait_for(q.get(), timeout=0.25)
            yield ev
        except asyncio.TimeoutError:
            continue


async def stream_pool_comfy_run(
    pool,
    wf: dict,
    *,
    client=None,
    timeout: int = 300,
    start: float = 0.05,
    end: float = 0.88,
    label: str = "ComfyUI",
    event: str = "progress",
    extra: Optional[dict] = None,
) -> AsyncIterator[dict]:
    """
    Async generator: yield eventi progress, ultimo yield è sentinel {"_result": ...}.
    """
    from src.core.comfyui.pool import ComfyUIRunResult

    q, progress_cb = bind_comfy_progress_queue(
        start=start, end=end, label=label, event=event, extra=extra,
    )
    if client is not None:
        task = asyncio.create_task(
            pool.run_workflow_on(client, wf, timeout=timeout, progress_cb=progress_cb)
        )
    else:
        task = asyncio.create_task(
            pool.run_with_fallback(wf, timeout=timeout, progress_cb=progress_cb)
        )
    async for ev in iter_progress_while(task, q):
        yield ev
    if client is not None:
        hist, prompt_id = await task
        yield {"_result": ComfyUIRunResult(history=hist, client=client, prompt_id=prompt_id)}
    else:
        yield {"_result": await task}
