"""
Client asincrono per l'API ComfyUI (HTTP + WebSocket).
"""

import json
import uuid
import asyncio
from pathlib import Path
from typing import Any, Callable, Optional, Union
from urllib.parse import parse_qs, urlencode, urljoin, urlparse

import httpx
import structlog
import websockets

from src.core.comfyui.execution_watchdog import (
    ExecutionWatchdog,
    resolve_execution_timeouts,
)
from src.core.config import ComfyUINodeConfig

_log = structlog.get_logger("comfyui.client")

# ComfyUI nativo usa underscore; alcuni proxy espongono anche varianti kebab-case.
_API_PATH_CANDIDATES: dict[str, list[str]] = {
    "system_stats": ["/system_stats", "/system-stats"],
    "object_info": ["/object_info", "/object-info"],
    "queue": ["/queue"],
    "prompt": ["/prompt"],
    "history_all": ["/history"],
}


class ComfyUIClient:
    """Client per un singolo nodo ComfyUI."""

    def __init__(self, node: ComfyUINodeConfig):
        self._node = node
        self._client_id = str(uuid.uuid4())
        self._resolved_paths: dict[str, str] = {}
        self._session_ready = False
        self._upload_supported: Optional[bool] = None
        self._http: Optional[httpx.AsyncClient] = None

    def _http_auth(self) -> Optional[tuple[str, str]]:
        if self._node.auth_type != "basic" or not self._node.auth:
            return None
        if ":" not in self._node.auth:
            return None
        user, _, password = self._node.auth.partition(":")
        return user, password

    def _bearer_token(self) -> Optional[str]:
        if self._node.auth_type == "token" and self._node.token:
            return self._node.token.strip()
        return None

    def _auth_headers(self) -> dict[str, str]:
        """
        RunPod (proxy Caddy): ?token= su POST /prompt restituisce solo exec_info (no-op).
        Serve Authorization: Bearer oppure cookie di sessione senza query token.
        """
        token = self._bearer_token()
        if token:
            return {"Authorization": f"Bearer {token}"}
        return {}

    def _http_extra(self) -> dict[str, Any]:
        extra: dict[str, Any] = {}
        headers = self._auth_headers()
        if headers:
            extra["headers"] = headers
        else:
            params = self._node.query_params()
            if params:
                extra["params"] = params
        auth = self._http_auth()
        if auth:
            extra["auth"] = auth
        return extra

    def _ws_connect_url(self) -> str:
        qs: dict[str, str] = {"clientId": self._client_id}
        # Non aggiungere ?token= al WS se usiamo Bearer (rompe alcuni proxy)
        if not self._bearer_token():
            qs.update(self._node.query_params())
        return f"{self._node.ws_url}?{urlencode(qs)}"

    def _url_with_token(self, location: str) -> str:
        """Risolve redirect relativi e re-inietta ?token= se il proxy lo rimuove."""
        url = urljoin(f"{self._node.base_url}/", location.lstrip("/"))
        parsed = urlparse(url)
        qs = parse_qs(parsed.query)
        for key, value in self._node.query_params().items():
            if key not in qs:
                qs[key] = [value]
        if not qs:
            return url
        query = urlencode({k: v[0] for k, v in qs.items()})
        return f"{parsed.scheme}://{parsed.netloc}{parsed.path}?{query}"

    def _paths_for(self, key: str, default: str) -> list[str]:
        if key in self._resolved_paths:
            return [self._resolved_paths[key]]
        return _API_PATH_CANDIDATES.get(key, [default])

    async def _http_client(self, timeout: float = 60.0) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=timeout, follow_redirects=True)
            await self._ensure_session(self._http)
        return self._http

    def _ws_headers(self) -> dict[str, str]:
        headers = dict(self._auth_headers())
        if self._http and self._http.cookies:
            cookie = "; ".join(f"{k}={v}" for k, v in self._http.cookies.items())
            if cookie:
                headers["Cookie"] = cookie
        return headers

    async def _ensure_session(self, client: httpx.AsyncClient) -> None:
        """Bootstrap sessione (opzionale). Con Bearer non serve ?token= su ogni richiesta."""
        if self._session_ready:
            return
        if not self._bearer_token():
            self._session_ready = True
            return
        try:
            await client.get(
                f"{self._node.base_url}/",
                headers=self._auth_headers(),
                follow_redirects=True,
            )
        except Exception:
            pass
        self._session_ready = True

    async def _request(
        self,
        method: str,
        path_key: str,
        default_path: str,
        *,
        timeout: float = 5.0,
        **kwargs: Any,
    ) -> httpx.Response:
        """
        Esegue una richiesta API provando path alternativi.
        follow_redirects=True mantiene ?token= su proxy RunPod/Vast.
        """
        paths = self._paths_for(path_key, default_path)
        # Un solo merge: download_output e altri caller passano già kwargs da _http_extra()
        merged: dict[str, Any] = {**self._http_extra(), **kwargs}
        last_error: Optional[Exception] = None
        client = await self._http_client(timeout=timeout)

        for path in paths:
            url = f"{self._node.base_url}{path}"
            try:
                r = await client.request(method, url, **merged)
                if r.status_code == 404 and path != paths[-1]:
                    continue
                r.raise_for_status()
                self._resolved_paths[path_key] = path
                return r
            except Exception as e:
                last_error = e

        if last_error:
            raise last_error
        raise RuntimeError(f"Nessun path valido per {path_key}")

    # ── Workflow ───────────────────────────────────────────────────────────────

    async def _history_prompt_ids(self) -> set[str]:
        r = await self._request("GET", "history_all", "/history", timeout=15.0)
        data = r.json()
        return set(data.keys()) if isinstance(data, dict) else set()

    async def queue_prompt(self, workflow: dict) -> str:
        """Accoda un workflow e restituisce il prompt_id."""
        before = await self._history_prompt_ids()
        r = await self._request(
            "POST",
            "prompt",
            "/prompt",
            timeout=30.0,
            json={"prompt": workflow, "client_id": self._client_id},
        )
        body = r.json()
        pid = body.get("prompt_id")
        if pid:
            return str(pid)

        # Proxy RunPod senza Bearer: risposta finta {"exec_info": {...}} — workflow non accodato
        if body.get("exec_info") and not body.get("node_errors"):
            raise RuntimeError(
                "ComfyUI proxy (RunPod): POST /prompt non ha accodato il workflow. "
                "Verifica auth_type=token e che il client invii Authorization: Bearer. "
                f"Risposta: {body!r}"
            )

        # Fallback: cerca prompt_id in history/coda
        loop = asyncio.get_event_loop()
        deadline = loop.time() + 30.0
        while loop.time() < deadline:
            await asyncio.sleep(0.5)
            after = await self._history_prompt_ids()
            new_ids = after - before
            if new_ids:
                return sorted(new_ids)[-1]
            try:
                qr = await self._request("GET", "queue", "/queue", timeout=5.0)
                qdata = qr.json()
                for item in qdata.get("queue_running", []) + qdata.get("queue_pending", []):
                    if isinstance(item, (list, tuple)) and len(item) > 1:
                        return str(item[1])
            except Exception:
                pass

        raise RuntimeError(
            f"ComfyUI non ha restituito prompt_id (proxy). Risposta: {body!r}"
        )

    async def wait_for_completion(
        self,
        prompt_id: str,
        timeout: int = 300,
        progress_cb: Optional[Union[Callable[[int, int], None], Callable[[int, int, Optional[str]], None]]] = None,
        *,
        max_timeout_sec: Optional[int] = None,
        idle_timeout_sec: Optional[int] = None,
    ) -> dict:
        """
        Attende il completamento via WebSocket + polling coda/history.

        Non usa `timeout` come deadline fissa: attende finché ComfyUI mostra attività
        (eventi WS, prompt in coda, history in corso). Scade solo dopo
        execution_idle_timeout_sec senza segnali o execution_max_timeout_sec assoluto.
        """
        max_sec, idle_sec = resolve_execution_timeouts(
            timeout,
            max_timeout_sec=max_timeout_sec,
            idle_timeout_sec=idle_timeout_sec,
        )
        watchdog = ExecutionWatchdog(max_timeout_sec=max_sec, idle_timeout_sec=idle_sec)
        watchdog.touch("queued")

        _log.info(
            "comfyui_wait_start",
            prompt_id=prompt_id,
            max_timeout_sec=max_sec,
            idle_timeout_sec=idle_sec,
        )

        ws_url = self._ws_connect_url()
        last_progress: tuple[int, int] = (0, 1)

        def _emit_progress(value: int, max_val: int, node: Optional[str] = None) -> None:
            nonlocal last_progress
            if max_val < 1:
                max_val = 1
            if value == last_progress[0] and max_val == last_progress[1] and not node:
                return
            last_progress = (value, max_val)
            watchdog.touch(f"progress:{node or 'sampling'}")
            if not progress_cb:
                return
            try:
                progress_cb(value, max_val, node)
            except TypeError:
                progress_cb(value, max_val)

        from src.core.comfyui.workflow_builder import extract_history_error, extract_output_files

        async def _poll_history_once() -> Optional[dict]:
            hist = await self.get_history(prompt_id)
            if extract_output_files(hist):
                return hist
            status = hist.get("status") if isinstance(hist.get("status"), dict) else {}
            if status.get("status_str") == "error":
                err = extract_history_error(hist) or "ComfyUI error"
                raise RuntimeError(err)
            if hist:
                watchdog.touch("history_poll")
            return None

        async def _wait_after_executed(ws_out: dict, node_id: Optional[str]) -> dict:
            from src.core.comfyui.workflow_builder import inject_ws_executed_output

            while watchdog.should_continue():
                hist = await self.get_history(prompt_id)
                if isinstance(ws_out, dict) and ws_out:
                    hist = inject_ws_executed_output(hist, node_id, ws_out)
                if extract_output_files(hist):
                    return hist
                status = hist.get("status") if isinstance(hist.get("status"), dict) else {}
                if status.get("status_str") == "error":
                    err = extract_history_error(hist) or "ComfyUI error"
                    raise RuntimeError(err)
                active, state = await self.get_prompt_run_state(prompt_id)
                if active:
                    watchdog.touch(f"post_executed:{state}")
                elif watchdog.idle_exceeded():
                    break
                await asyncio.sleep(1.5)
            hist = await self.get_history(prompt_id)
            if isinstance(ws_out, dict) and ws_out:
                hist = inject_ws_executed_output(hist, node_id, ws_out)
            return hist

        async def _poll_until_done_or_timeout() -> dict:
            last_state = "unknown"
            while watchdog.should_continue():
                polled = await _poll_history_once()
                if polled is not None:
                    return polled
                active, last_state = await self.get_prompt_run_state(prompt_id)
                if active:
                    if watchdog.idle_exceeded():
                        _log.debug(
                            "comfyui_idle_reset",
                            prompt_id=prompt_id,
                            state=last_state,
                            idle_sec=round(watchdog.idle_sec, 1),
                        )
                    watchdog.touch(f"queue:{last_state}")
                elif watchdog.idle_exceeded():
                    break
                await asyncio.sleep(2.0)
            raise TimeoutError(watchdog.timeout_message(prompt_id, last_state))

        ws_headers = self._ws_headers()
        last_history_poll = 0.0
        ws_failed = False
        try:
            async with websockets.connect(
                ws_url,
                ping_interval=20,
                ping_timeout=30,
                additional_headers=ws_headers or None,
            ) as ws:
                while watchdog.should_continue():
                    now = asyncio.get_event_loop().time()
                    if now - last_history_poll >= 4.0:
                        last_history_poll = now
                        polled = await _poll_history_once()
                        if polled is not None:
                            return polled
                        active, state = await self.get_prompt_run_state(prompt_id)
                        if active:
                            watchdog.touch(f"poll:{state}")

                    if watchdog.idle_exceeded():
                        active, state = await self.get_prompt_run_state(prompt_id)
                        if active:
                            watchdog.touch(f"idle_extend:{state}")
                        else:
                            break

                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=15.0)
                    except asyncio.TimeoutError:
                        continue

                    msg = json.loads(raw)
                    mtype = msg.get("type")
                    data = msg.get("data") or {}

                    if mtype == "progress":
                        pid = data.get("prompt_id")
                        if pid and pid != prompt_id:
                            continue
                        _emit_progress(
                            int(data.get("value", 0)),
                            int(data.get("max", 1)),
                            data.get("node"),
                        )

                    elif mtype == "executing":
                        pid = data.get("prompt_id")
                        if pid and pid != prompt_id:
                            continue
                        node = data.get("node")
                        watchdog.touch(f"executing:{node or 'done'}")
                        if node is None:
                            _emit_progress(last_progress[0], max(last_progress[1], 1), None)
                        else:
                            _emit_progress(
                                0,
                                last_progress[1] if last_progress[1] > 1 else 1,
                                node,
                            )

                    elif mtype == "executed":
                        data = msg.get("data", {})
                        if data.get("prompt_id") == prompt_id:
                            from src.core.comfyui.workflow_builder import (
                                inject_ws_executed_output,
                            )

                            ws_hist: dict = {}
                            ws_out = data.get("output")
                            if isinstance(ws_out, dict) and ws_out:
                                ws_hist = inject_ws_executed_output(
                                    ws_hist, data.get("node"), ws_out,
                                )
                                if extract_output_files(ws_hist):
                                    return ws_hist
                            watchdog.touch("executed")
                            return await _wait_after_executed(
                                ws_out if isinstance(ws_out, dict) else {},
                                data.get("node"),
                            )

                    elif mtype == "execution_error":
                        data = msg.get("data", {})
                        if data.get("prompt_id") == prompt_id:
                            raise RuntimeError(
                                f"ComfyUI error: {data.get('exception_message', 'unknown')}"
                            )

                    elif mtype == "execution_interrupted":
                        data = msg.get("data", {})
                        pid = data.get("prompt_id") if isinstance(data, dict) else None
                        if not pid or pid == prompt_id:
                            raise RuntimeError(
                                f"ComfyUI job {prompt_id} interrotto (execution_interrupted)"
                            )
        except Exception as exc:
            ws_failed = True
            _log.warning("comfyui_ws_fallback", prompt_id=prompt_id, error=str(exc))
            watchdog.touch("ws_fallback")

        if ws_failed or watchdog.should_continue():
            return await _poll_until_done_or_timeout()

        raise TimeoutError(watchdog.timeout_message(prompt_id))

    async def get_history(self, prompt_id: str) -> dict:
        """Recupera l'output di un prompt completato."""
        r = await self._request(
            "GET",
            "history",
            f"/history/{prompt_id}",
            timeout=15.0,
        )
        return r.json().get(prompt_id, {})

    async def refresh_history_until_outputs(
        self,
        prompt_id: str,
        *,
        timeout: float = 45.0,
        poll_interval: float = 1.5,
    ) -> dict:
        """
        Ripoll history finché compaiono output file (proxy RunPod spesso in ritardo).
        Esce subito se la history riporta un errore — evita blocco su job falliti.
        """
        from src.core.comfyui.workflow_builder import extract_history_error, extract_output_files

        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        last: dict = {}
        while loop.time() < deadline:
            last = await self.get_history(prompt_id)
            if extract_output_files(last):
                return last
            err = extract_history_error(last)
            if err:
                raise RuntimeError(f"ComfyUI job {prompt_id} fallito: {err}")
            # Job ancora in coda / esecuzione — polling status
            status = last.get("status") if isinstance(last.get("status"), dict) else {}
            if status.get("status_str") in ("error", "cancelled"):
                raise RuntimeError(
                    f"ComfyUI job {prompt_id} terminato senza output (status={status.get('status_str')})"
                )
            await asyncio.sleep(poll_interval)
        return last

    # ── File ──────────────────────────────────────────────────────────────────

    async def supports_upload(self) -> bool:
        """RunPod proxy espone spesso solo GET; /upload/image ritorna 404."""
        if self._upload_supported is not None:
            return self._upload_supported
        loop = asyncio.get_event_loop()

        def _probe() -> bool:
            import requests
            session = requests.Session()
            headers = self._auth_headers()
            try:
                if headers:
                    session.get(
                        f"{self._node.base_url}/",
                        headers=headers,
                        timeout=10,
                        allow_redirects=True,
                    )
                r = session.post(
                    f"{self._node.base_url}/upload/image",
                    headers=headers or None,
                    files={"image": ("probe.txt", b"probe", "text/plain")},
                    data={"type": "input", "overwrite": "true"},
                    timeout=15,
                )
                return r.status_code not in (404, 405, 501)
            except Exception:
                return False

        self._upload_supported = await loop.run_in_executor(None, _probe)
        return self._upload_supported

    async def upload_input_file(
        self,
        file_path: Path,
        *,
        mime: str = "application/octet-stream",
        field_name: str = "image",
    ) -> str:
        """Carica un file in input ComfyUI (immagine, audio, ecc.) con auth/token."""
        size_mb = file_path.stat().st_size / (1024 * 1024)
        timeout = max(120.0, size_mb * 45.0)
        last_err: Optional[Exception] = None
        for attempt in range(3):
            try:
                with open(file_path, "rb") as f:
                    r = await self._request(
                        "POST",
                        "upload_image",
                        "/upload/image",
                        timeout=timeout,
                        files={field_name: (file_path.name, f, mime)},
                        data={"type": "input", "overwrite": "true"},
                    )
                return r.json()["name"]
            except (httpx.ReadError, httpx.ConnectError, httpx.WriteError, httpx.RemoteProtocolError) as e:
                last_err = e
                if attempt < 2:
                    await asyncio.sleep(2 ** attempt)
        if last_err:
            raise last_err
        raise RuntimeError(f"Upload failed for {file_path}")

    async def upload_image(self, image_path: Path) -> str:
        """Carica un'immagine e restituisce il nome file su ComfyUI."""
        suffix = image_path.suffix.lower()
        mime = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
        }.get(suffix, "image/png")
        return await self.upload_input_file(image_path, mime=mime)

    async def download_output(self, filename: str, dest: Path, subfolder: str = "", ftype: str = "output") -> Path:
        """Scarica un file di output: valida il body, poi scrive su disco atomicamente."""
        import structlog
        from src.core.utils.comfyui_outputs import ensure_parent_dir, validate_downloaded_bytes

        _log = structlog.get_logger("comfyui.download")
        view_params = {"filename": filename, "subfolder": subfolder, "type": ftype}
        base = self._http_extra()
        params = {**view_params, **(base.get("params") or {})}
        # RunPod: Bearer su POST ma GET /view spesso richiede anche ?token=
        if self._bearer_token():
            params = {**params, **self._node.query_params()}
        headers = base.get("headers")
        r = await self._request(
            "GET", "view", "/view", timeout=120.0, params=params, headers=headers,
        )

        data = r.content
        if not data:
            raise ValueError(f"ComfyUI /view empty body for {filename!r}")

        ext = Path(filename).suffix.lower()
        expect = "video" if ext in {".mp4", ".webm", ".avi", ".mov", ".mkv", ".gif"} else "image"
        try:
            validate_downloaded_bytes(data, expect=expect)
        except ValueError as exc:
            preview = data[:120].decode("utf-8", errors="replace")
            raise ValueError(
                f"Download non valido per {filename!r} ({len(data)} bytes): {exc} — body: {preview!r}"
            ) from exc

        ensure_parent_dir(dest)
        tmp = dest.with_suffix(dest.suffix + ".tmp")
        try:
            tmp.write_bytes(data)
            tmp.replace(dest)
        except Exception:
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass
            raise

        _log.debug("download_output_ok", filename=filename, dest=str(dest), size=len(data))
        return dest

    # ── Salute ────────────────────────────────────────────────────────────────

    async def health_check(self) -> dict:
        """Restituisce le statistiche di sistema del nodo."""
        r = await self._request("GET", "system_stats", "/system_stats", timeout=5.0)
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
            r = await self._request("GET", "queue", "/queue", timeout=5.0)
            data = r.json()
            return len(data.get("queue_running", [])) + len(data.get("queue_pending", []))
        except Exception:
            return 999  # Nodo non raggiungibile = coda "piena"

    async def get_prompt_run_state(self, prompt_id: str) -> tuple[bool, str]:
        """
        True se il prompt sembra ancora in esecuzione (coda o history incompleta).
        Usato dal watchdog per non scadere mentre ComfyUI lavora senza eventi WS.
        """
        from src.core.comfyui.workflow_builder import extract_history_error, extract_output_files

        hist: dict = {}
        try:
            hist = await self.get_history(prompt_id)
        except Exception:
            pass

        if hist:
            if extract_output_files(hist):
                return False, "completed"
            status = hist.get("status") if isinstance(hist.get("status"), dict) else {}
            if status.get("status_str") == "error":
                return False, "error"
            if status.get("completed") is False:
                return True, "history_incomplete"

        try:
            r = await self._request("GET", "queue", "/queue", timeout=5.0)
            data = r.json()
            for label, key in (("running", "queue_running"), ("pending", "queue_pending")):
                for item in data.get(key, []):
                    if isinstance(item, (list, tuple)) and len(item) > 1 and str(item[1]) == prompt_id:
                        return True, label
        except Exception:
            pass

        if hist:
            return True, "history_no_output"
        return False, "not_queued"

    async def get_object_info(self) -> dict:
        """Elenco nodi e modelli disponibili."""
        r = await self._request("GET", "object_info", "/object_info", timeout=15.0)
        return r.json()
