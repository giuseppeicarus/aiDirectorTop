"""
Monitoraggio esecuzione ComfyUI basato su attività reale (non timeout fisso).

- idle_timeout: fallisce solo dopo N secondi senza progresso / coda / WS
- max_timeout: tetto assoluto di sicurezza (ore per video LTX lunghi)
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Literal, Optional

import structlog

log = structlog.get_logger()

RunState = Literal[
    "completed",
    "error",
    "running",
    "pending",
    "history_incomplete",
    "history_no_output",
    "not_queued",
    "unknown",
]


@dataclass
class ExecutionWatchdog:
    """Traccia attività e decide se continuare ad attendere ComfyUI."""

    max_timeout_sec: int
    idle_timeout_sec: int
    _start: float = field(default_factory=time.monotonic)
    _last_activity: float = field(default_factory=time.monotonic)
    _last_reason: str = ""

    def touch(self, reason: str = "") -> None:
        self._last_activity = time.monotonic()
        if reason:
            self._last_reason = reason

    @property
    def elapsed_sec(self) -> float:
        return time.monotonic() - self._start

    @property
    def idle_sec(self) -> float:
        return time.monotonic() - self._last_activity

    def max_exceeded(self) -> bool:
        return self.elapsed_sec >= self.max_timeout_sec

    def idle_exceeded(self) -> bool:
        return self.idle_sec >= self.idle_timeout_sec

    def should_continue(self) -> bool:
        return not self.max_exceeded()

    def timeout_message(self, prompt_id: str, run_state: str = "") -> str:
        parts = [
            f"ComfyUI prompt {prompt_id}:",
        ]
        if self.max_exceeded():
            parts.append(
                f"superato limite assoluto {self.max_timeout_sec}s "
                f"(trascorsi {int(self.elapsed_sec)}s)."
            )
        elif self.idle_exceeded():
            parts.append(
                f"nessuna attività per {self.idle_timeout_sec}s "
                f"(ultimo segnale: {self._last_reason or 'nessuno'})."
            )
        if run_state:
            parts.append(f"Stato: {run_state}.")
        parts.append(
            "Il job non risulta più in coda né in esecuzione — "
            "verifica ComfyUI o aumenta comfyui.execution_idle_timeout_sec."
        )
        return " ".join(parts)


def resolve_execution_timeouts(
    timeout: Optional[int] = None,
    *,
    max_timeout_sec: Optional[int] = None,
    idle_timeout_sec: Optional[int] = None,
) -> tuple[int, int]:
    """
    Risolve max/idle da config. Il parametro legacy `timeout` non limita più
    la durata se è il vecchio execution_timeout_sec (usa max da config).
    """
    from src.core.config import get_config

    cfg = get_config().comfyui
    max_sec = max_timeout_sec if max_timeout_sec is not None else cfg.execution_max_timeout_sec
    idle_sec = idle_timeout_sec if idle_timeout_sec is not None else cfg.execution_idle_timeout_sec

    # Override esplicito solo se molto alto (es. test o job speciale)
    if timeout is not None and timeout > max_sec:
        max_sec = timeout

    return max(60, int(max_sec)), max(30, int(idle_sec))
