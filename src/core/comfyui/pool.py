"""
Pool di nodi ComfyUI: nodo principale + fallback se offline o in errore.
"""

import asyncio
import time
from dataclasses import dataclass
from typing import Optional

import structlog

from src.core.comfyui.client import ComfyUIClient, ComfyUIExecutionInterrupted
from src.core.comfyui.execution_watchdog import resolve_execution_timeouts
from src.core.config import get_config, ComfyUINodeConfig

log = structlog.get_logger()

QUARANTINE_SECONDS = 60

_VIDEO_SAVERS = {"SaveAnimatedWEBP", "VHS_VideoCombine", "SaveVideo", "VideoSave"}
_SAMPLERS = {"KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced", "LTXVScheduler"}


def _infer_stat_meta(workflow: dict) -> tuple[str, str, int, int, int, float]:
    """
    Heuristically extract (kind, workflow_name, width, height, steps, duration_sec)
    from a ComfyUI workflow dict. Returns defaults if unable to determine.
    """
    kind = "image"
    wf_name = ""
    width = height = steps = 0
    duration_sec = 0.0

    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        ctype = node.get("class_type", "")
        inp = node.get("inputs", {})

        if ctype in _VIDEO_SAVERS:
            kind = "video"

        if ctype in ("EmptyLatentImage", "EmptySD3LatentImage"):
            width = width or int(inp.get("width", 0))
            height = height or int(inp.get("height", 0))

        if ctype in _SAMPLERS:
            steps = steps or int(inp.get("steps", inp.get("num_steps", 0)))

        # LTX / WAN video frames → estimate duration
        if ctype in ("LTXVConditioning", "LTXVidConditioningNode"):
            frame_rate = inp.get("frame_rate", 24)
            num_frames = inp.get("num_frames", inp.get("length", 0))
            if num_frames and frame_rate:
                duration_sec = duration_sec or round(num_frames / frame_rate, 2)

        if ctype == "WanVideoSampler":
            frame_rate = inp.get("fps", 24)
            num_frames = inp.get("num_frames", 0)
            if num_frames and frame_rate:
                duration_sec = duration_sec or round(num_frames / frame_rate, 2)

        if ctype in ("SaveImage", "Image Save"):
            prefix = inp.get("filename_prefix", "")
            if prefix and not wf_name:
                wf_name = str(prefix).split("/")[0][:40]

    return kind, wf_name, width, height, steps, duration_sec


@dataclass
class ComfyUIRunResult:
    """History ComfyUI + client del nodo che ha eseguito il workflow (per download)."""
    history: dict
    client: ComfyUIClient
    node_name: str = ""
    prompt_id: str = ""


class NodeEntry:
    def __init__(self, config: ComfyUINodeConfig):
        self.config = config
        self.client = ComfyUIClient(config)
        self.quarantined_until: float = 0.0

    @property
    def is_available(self) -> bool:
        return time.monotonic() > self.quarantined_until

    def quarantine(self):
        self.quarantined_until = time.monotonic() + QUARANTINE_SECONDS
        log.warning("comfyui_node_quarantined", node=self.config.name, seconds=QUARANTINE_SECONDS)

    def release(self):
        self.quarantined_until = 0.0


class ComfyUINodePool:
    """Pool con priorità: nodo principale, poi fallback."""

    def __init__(self):
        config = get_config().comfyui
        self._nodes = [
            NodeEntry(n) for n in config.nodes if n.enabled
        ]
        self._lock = asyncio.Lock()

        if not self._nodes:
            raise ValueError("Nessun nodo ComfyUI abilitato in configurazione!")

    def _has_primary(self) -> bool:
        return any(n.config.primary for n in self._nodes)

    def _priority_entries(self) -> list[NodeEntry]:
        """Principale per primo, poi gli altri. Senza primary: ordine config."""
        primary = [n for n in self._nodes if n.config.primary]
        others = [n for n in self._nodes if not n.config.primary]
        if primary:
            return primary + others
        return list(self._nodes)

    async def _wait_for_available(self) -> list[NodeEntry]:
        ordered = self._priority_entries()
        available = [n for n in ordered if n.is_available]
        if available:
            return available

        soonest = min(self._nodes, key=lambda n: n.quarantined_until)
        wait = soonest.quarantined_until - time.monotonic()
        log.warning("all_nodes_quarantined", wait_seconds=round(wait, 1))
        await asyncio.sleep(max(0, wait))
        soonest.release()
        return [soonest]

    async def _pick_best_online(self, candidates: list[NodeEntry]) -> Optional[NodeEntry]:
        """Tra i candidati online, sceglie quello con coda più corta."""
        online: list[NodeEntry] = []
        for entry in candidates:
            if await entry.client.is_alive():
                online.append(entry)
        if not online:
            return None
        depths = await asyncio.gather(*[n.client.get_queue_depth() for n in online])
        return online[depths.index(min(depths))]

    async def get_client(self) -> ComfyUIClient:
        """
        Restituisce il client del nodo principale se online.
        Altrimenti il miglior nodo di fallback (meno carico in coda).
        """
        async with self._lock:
            available = await self._wait_for_available()
            ordered = [e for e in self._priority_entries() if e in available]

            if self._has_primary():
                primary_list = [e for e in ordered if e.config.primary]
                fallback_list = [e for e in ordered if not e.config.primary]

                best_primary = await self._pick_best_online(primary_list)
                if best_primary:
                    log.debug("comfyui_using_primary", node=best_primary.config.name)
                    return best_primary.client

                if primary_list:
                    log.warning(
                        "comfyui_primary_offline",
                        node=primary_list[0].config.name,
                    )

                best_fallback = await self._pick_best_online(fallback_list)
                if best_fallback:
                    log.info("comfyui_using_fallback", node=best_fallback.config.name)
                    return best_fallback.client

                raise RuntimeError(
                    "Nodo ComfyUI principale offline e nessun fallback disponibile."
                )

            best = await self._pick_best_online(ordered)
            if best:
                return best.client
            raise RuntimeError("Nessun nodo ComfyUI raggiungibile.")

    async def run_workflow_on(
        self,
        client: ComfyUIClient,
        workflow: dict,
        timeout: int = 300,
        progress_cb=None,
    ) -> tuple[dict, str]:
        """Esegue workflow sul client indicato (stesso nodo di upload/download)."""
        max_sec, idle_sec = resolve_execution_timeouts(timeout)
        prompt_id = await client.queue_prompt(workflow)
        hist = await client.wait_for_completion(
            prompt_id,
            max_timeout_sec=max_sec,
            idle_timeout_sec=idle_sec,
            progress_cb=progress_cb,
        )
        return hist, prompt_id

    async def run_with_fallback(
        self,
        workflow: dict,
        timeout: int = 300,
        progress_cb=None,
        # optional metadata for gen_stats tracking
        _stat_kind: str = "",
        _stat_workflow: str = "",
        _stat_width: int = 0,
        _stat_height: int = 0,
        _stat_steps: int = 0,
        _stat_duration_sec: float = 0.0,
    ) -> ComfyUIRunResult:
        """
        Esegue un workflow: prova prima il nodo principale, poi i fallback in ordine.
        Restituisce history + client del nodo che ha eseguito (per scaricare output).
        """
        tried: set[str] = set()
        ordered = self._priority_entries()
        _t_start = time.monotonic()

        # Auto-detect stat metadata from workflow if not provided
        if not _stat_kind and isinstance(workflow, dict):
            _stat_kind, _stat_workflow, _stat_width, _stat_height, _stat_steps, _stat_duration_sec = \
                _infer_stat_meta(workflow)

        for entry in ordered:
            if not entry.is_available:
                continue
            node_url = entry.client._node.base_url
            if node_url in tried:
                continue
            tried.add(node_url)

            if entry.config.primary and self._has_primary():
                if not await entry.client.is_alive():
                    log.warning(
                        "comfyui_primary_offline_skip",
                        node=entry.config.name,
                    )
                    continue
            elif self._has_primary():
                log.info("comfyui_fallback_attempt", node=entry.config.name)

            _interrupted_retries = 0
            while True:
              try:
                from src.core.comfyui.model_check import (
                    bypass_missing_loras,
                    validate_workflow_models,
                )
                from src.core.comfyui.workflow_builder import (
                    extract_history_error,
                    extract_output_files,
                )

                try:
                    oi = await entry.client.get_object_info()
                    check = validate_workflow_models(oi, workflow)
                    removed_loras = bypass_missing_loras(
                        workflow,
                        check.get("missing", []),
                    )
                    if removed_loras:
                        log.warning(
                            "comfyui_optional_loras_bypassed",
                            node=entry.config.name,
                            loras=removed_loras,
                        )
                        check = validate_workflow_models(oi, workflow)
                    if not check.get("ok"):
                        missing = ", ".join(
                            f"{m['kind']}:{m['name']}" for m in check.get("missing", [])
                        )
                        raise RuntimeError(
                            f"Modelli mancanti su {entry.config.name}: {missing}"
                        )
                    for hint in check.get("hints") or []:
                        log.warning("comfyui_model_hint", node=entry.config.name, hint=hint)
                except RuntimeError:
                    raise
                except Exception:
                    pass

                hist, prompt_id = await self.run_workflow_on(
                    entry.client, workflow, timeout=timeout, progress_cb=progress_cb,
                )
                err = extract_history_error(hist)
                if err:
                    raise RuntimeError(err)
                if not extract_output_files(hist):
                    log.warning(
                        "comfyui_history_no_files",
                        node=entry.config.name,
                        prompt_id=prompt_id,
                        msg="History senza file — download per prefisso /view",
                    )
                elapsed = time.monotonic() - _t_start
                if _stat_kind:
                    try:
                        from src.core.comfyui.gen_stats import record as _record_stat
                        _record_stat(
                            kind=_stat_kind,
                            workflow=_stat_workflow,
                            elapsed_sec=elapsed,
                            width=_stat_width,
                            height=_stat_height,
                            steps=_stat_steps,
                            duration_sec=_stat_duration_sec,
                            node=entry.config.name,
                        )
                    except Exception:
                        pass
                return ComfyUIRunResult(
                    history=hist,
                    client=entry.client,
                    node_name=entry.config.name,
                    prompt_id=prompt_id,
                )
              except ComfyUIExecutionInterrupted as e:
                if _interrupted_retries < 1:
                    _interrupted_retries += 1
                    log.warning(
                        "comfyui_job_interrupted_retrying",
                        node=node_url,
                        error=str(e),
                        retry=_interrupted_retries,
                    )
                    await asyncio.sleep(3)
                    continue
                log.error("comfyui_job_interrupted_giving_up", node=node_url, error=str(e))
                break
              except Exception as e:
                log.error("comfyui_node_failed", node=node_url, error=str(e))
                entry.quarantine()
                break

        raise RuntimeError("Tutti i nodi ComfyUI hanno fallito l'esecuzione del workflow.")

    async def status(self) -> list[dict]:
        """Restituisce lo stato di tutti i nodi (ordine: principale per primo)."""
        results = []
        for entry in self._priority_entries():
            alive = await entry.client.is_alive()
            depth = await entry.client.get_queue_depth() if alive else -1
            results.append({
                "name": entry.config.name,
                "host": entry.config.host,
                "port": entry.config.port,
                "primary": entry.config.primary,
                "online": alive,
                "quarantined": not entry.is_available,
                "queue_depth": depth,
            })
        return results

    def primary_node_name(self) -> Optional[str]:
        for entry in self._nodes:
            if entry.config.primary:
                return entry.config.name
        return self._nodes[0].config.name if self._nodes else None
