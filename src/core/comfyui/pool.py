"""
Pool di nodi ComfyUI: nodo principale + fallback se offline o in errore.
"""

import asyncio
import time
from dataclasses import dataclass
from typing import Optional

import structlog

from src.core.comfyui.client import ComfyUIClient
from src.core.config import get_config, ComfyUINodeConfig

log = structlog.get_logger()

QUARANTINE_SECONDS = 60


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
        prompt_id = await client.queue_prompt(workflow)
        hist = await client.wait_for_completion(
            prompt_id, timeout=timeout, progress_cb=progress_cb,
        )
        return hist, prompt_id

    async def run_with_fallback(
        self,
        workflow: dict,
        timeout: int = 300,
        progress_cb=None,
    ) -> ComfyUIRunResult:
        """
        Esegue un workflow: prova prima il nodo principale, poi i fallback in ordine.
        Restituisce history + client del nodo che ha eseguito (per scaricare output).
        """
        tried: set[str] = set()
        ordered = self._priority_entries()

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

            try:
                from src.core.comfyui.workflow_builder import (
                    extract_history_error,
                    extract_output_files,
                )

                hist, prompt_id = await self.run_workflow_on(
                    entry.client, workflow, timeout=timeout, progress_cb=progress_cb,
                )
                if not extract_output_files(hist):
                    err = extract_history_error(hist)
                    raise RuntimeError(
                        err or f"ComfyUI ({entry.config.name}) senza output nel workflow",
                    )
                return ComfyUIRunResult(
                    history=hist,
                    client=entry.client,
                    node_name=entry.config.name,
                    prompt_id=prompt_id,
                )
            except Exception as e:
                log.error("comfyui_node_failed", node=node_url, error=str(e))
                entry.quarantine()

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
