"""
Client asincrono per l'API ComfyUI (HTTP + WebSocket).
"""

import json
import uuid
import asyncio
from pathlib import Path
from typing import Callable, Optional

import httpx
import websockets

from src.core.config import ComfyUINodeConfig


class ComfyUIClient:
    """Client per un singolo nodo ComfyUI."""

    def __init__(self, node: ComfyUINodeConfig):
        self._node = node
        self._client_id = str(uuid.uuid4())

    # ── Workflow ───────────────────────────────────────────────────────────────

    async def queue_prompt(self, workflow: dict) -> str:
        """Accoda un workflow e restituisce il prompt_id."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                f"{self._node.base_url}/prompt",
                json={"prompt": workflow, "client_id": self._client_id},
            )
            r.raise_for_status()
            return r.json()["prompt_id"]

    async def wait_for_completion(
        self,
        prompt_id: str,
        timeout: int = 300,
        progress_cb: Optional[Callable[[int, int], None]] = None,
    ) -> dict:
        """
        Attende il completamento via WebSocket.
        Restituisce l'output del nodo SaveImage/SaveVideo.
        """
        ws_url = f"{self._node.ws_url}?clientId={self._client_id}"
        deadline = asyncio.get_event_loop().time() + timeout

        async with websockets.connect(ws_url) as ws:
            while asyncio.get_event_loop().time() < deadline:
                remaining = deadline - asyncio.get_event_loop().time()
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=min(10.0, remaining))
                except asyncio.TimeoutError:
                    raise TimeoutError(f"ComfyUI non ha risposto entro {timeout}s")

                msg = json.loads(raw)
                mtype = msg.get("type")

                if mtype == "progress" and progress_cb:
                    d = msg["data"]
                    progress_cb(d.get("value", 0), d.get("max", 1))

                elif mtype == "executed":
                    data = msg.get("data", {})
                    if data.get("prompt_id") == prompt_id:
                        return await self.get_history(prompt_id)

                elif mtype == "execution_error":
                    data = msg.get("data", {})
                    if data.get("prompt_id") == prompt_id:
                        raise RuntimeError(
                            f"ComfyUI error: {data.get('exception_message', 'unknown')}"
                        )

        raise TimeoutError(f"Timeout {timeout}s scaduto per prompt {prompt_id}")

    async def get_history(self, prompt_id: str) -> dict:
        """Recupera l'output di un prompt completato."""
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(f"{self._node.base_url}/history/{prompt_id}")
            r.raise_for_status()
            return r.json().get(prompt_id, {})

    # ── File ──────────────────────────────────────────────────────────────────

    async def upload_image(self, image_path: Path) -> str:
        """Carica un'immagine e restituisce il nome file su ComfyUI."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            with open(image_path, "rb") as f:
                r = await client.post(
                    f"{self._node.base_url}/upload/image",
                    files={"image": (image_path.name, f, "image/png")},
                    data={"type": "input", "overwrite": "true"},
                )
            r.raise_for_status()
            return r.json()["name"]

    async def download_output(self, filename: str, dest: Path, subfolder: str = "", ftype: str = "output") -> Path:
        """Scarica un file di output e lo salva in dest."""
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.get(
                f"{self._node.base_url}/view",
                params={"filename": filename, "subfolder": subfolder, "type": ftype},
            )
            r.raise_for_status()
        dest.write_bytes(r.content)
        return dest

    # ── Salute ────────────────────────────────────────────────────────────────

    async def health_check(self) -> dict:
        """Restituisce le statistiche di sistema del nodo."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{self._node.base_url}/system_stats")
            r.raise_for_status()
            return r.json()

    async def is_alive(self) -> bool:
        try:
            await self.health_check()
            return True
        except Exception:
            return False

    async def get_queue_depth(self) -> int:
        """Numero di job in coda."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(f"{self._node.base_url}/queue")
                data = r.json()
                return len(data.get("queue_running", [])) + len(data.get("queue_pending", []))
        except Exception:
            return 999  # Nodo non raggiungibile = coda "piena"

    async def get_object_info(self) -> dict:
        """Elenco nodi e modelli disponibili."""
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(f"{self._node.base_url}/object_info")
            r.raise_for_status()
            return r.json()
