"""
Pool di nodi ComfyUI con round-robin, health check e quarantena automatica.
"""

import asyncio
import time
from typing import Optional

import structlog

from src.core.comfyui.client import ComfyUIClient
from src.core.config import get_config, ComfyUINodeConfig

log = structlog.get_logger()

QUARANTINE_SECONDS = 60


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
    """Pool con round-robin e fallback automatico su nodo sano."""

    def __init__(self):
        config = get_config().comfyui
        self._nodes = [
            NodeEntry(n) for n in config.nodes if n.enabled
        ]
        self._rr_index = 0
        self._lock = asyncio.Lock()

        if not self._nodes:
            raise ValueError("Nessun nodo ComfyUI abilitato in configurazione!")

    async def get_client(self) -> ComfyUIClient:
        """
        Restituisce il client del prossimo nodo disponibile (round-robin).
        Salta i nodi in quarantena. Preferisce quello con meno job in coda.
        """
        async with self._lock:
            available = [n for n in self._nodes if n.is_available]
            if not available:
                # Tutti in quarantena: aspetta il primo che si libera
                soonest = min(self._nodes, key=lambda n: n.quarantined_until)
                wait = soonest.quarantined_until - time.monotonic()
                log.warning("all_nodes_quarantined", wait_seconds=round(wait, 1))
                await asyncio.sleep(max(0, wait))
                soonest.release()
                available = [soonest]

            # Scegli il nodo con meno job in coda
            depths = await asyncio.gather(*[n.client.get_queue_depth() for n in available])
            best = available[depths.index(min(depths))]
            return best.client

    async def run_with_fallback(self, workflow: dict, timeout: int = 300,
                                 progress_cb=None) -> dict:
        """
        Esegue un workflow sul pool con fallback automatico su errore.
        """
        tried = set()
        for _ in range(len(self._nodes)):
            client = await self.get_client()
            node_url = client._node.base_url
            if node_url in tried:
                break
            tried.add(node_url)
            try:
                prompt_id = await client.queue_prompt(workflow)
                result = await client.wait_for_completion(prompt_id, timeout=timeout,
                                                          progress_cb=progress_cb)
                return result
            except Exception as e:
                log.error("comfyui_node_failed", node=node_url, error=str(e))
                # Quarantena il nodo fallito
                for entry in self._nodes:
                    if entry.client is client:
                        entry.quarantine()
                        break

        raise RuntimeError("Tutti i nodi ComfyUI hanno fallito l'esecuzione del workflow.")

    async def status(self) -> list[dict]:
        """Restituisce lo stato di tutti i nodi."""
        results = []
        for entry in self._nodes:
            alive = await entry.client.is_alive()
            depth = await entry.client.get_queue_depth() if alive else -1
            results.append({
                "name": entry.config.name,
                "host": entry.config.host,
                "port": entry.config.port,
                "online": alive,
                "quarantined": not entry.is_available,
                "queue_depth": depth,
            })
        return results
