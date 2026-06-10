"""Adapter for ostris/ai-toolkit LoRA training jobs."""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import httpx
import yaml

from src.core.config import get_config
from src.core.models.character import CharacterProfile, CharacterRecord


@dataclass
class AiToolkitRunResult:
    ok: bool
    status: str
    command: list[str]
    config_path: str
    dataset_dir: str
    output_dir: str
    lora_path: Optional[str] = None
    stdout_tail: str = ""
    stderr_tail: str = ""
    error: Optional[str] = None
_ACTIVE_PROCESSES: dict[str, CompatibleProcess] = {}


def docker_available() -> bool:
    return shutil.which("docker") is not None


def discover_toolkit_dir() -> Optional[Path]:
    cfg = get_config().ai_toolkit
    candidates = [
        cfg.toolkit_dir,
        os.environ.get("AI_TOOLKIT_DIR", ""),
        str(Path.cwd() / "ai-toolkit"),
        "F:/SOLO_AI/ai-toolkit",
        "F:/ai-toolkit",
        str(Path.home() / "ai-toolkit"),
    ]
    for raw in candidates:
        if not raw:
            continue
        path = Path(raw).expanduser()
        if (path / "run.py").is_file():
            return path
    return None


def profile_steps(profile: CharacterProfile) -> int:
    cfg = get_config().ai_toolkit
    return {
        "Low": cfg.low_steps,
        "Medium": cfg.medium_steps,
        "High": cfg.high_steps,
    }.get(profile, cfg.low_steps)


def profile_resolution(profile: CharacterProfile) -> int:
    cfg = get_config().ai_toolkit
    return {
        "Low": cfg.low_resolution,
        "Medium": cfg.medium_resolution,
        "High": cfg.high_resolution,
    }.get(profile, cfg.low_resolution)


def training_root() -> Path:
    cfg = get_config()
    if cfg.ai_toolkit.training_folder:
        root = Path(cfg.ai_toolkit.training_folder).expanduser()
    else:
        root = cfg.app.data_path / "ai-toolkit-training"
    root.mkdir(parents=True, exist_ok=True)
    return root


def container_training_root() -> str:
    return "/workspace/training"


def to_container_path(path: Path, record: CharacterRecord) -> str:
    root = training_root() / record.id
    rel = path.resolve().relative_to(root.resolve()).as_posix()
    return f"{container_training_root()}/{record.id}/{rel}"


def trigger_word(record: CharacterRecord) -> str:
    safe = "".join(ch.lower() for ch in record.name if ch.isalnum())[:16] or "character"
    return f"{get_config().ai_toolkit.trigger_word_prefix}_{safe}_{record.id[:4]}"


def prepare_dataset(record: CharacterRecord) -> Path:
    dataset_dir = training_root() / record.id / "dataset"
    dataset_dir.mkdir(parents=True, exist_ok=True)
    trig = trigger_word(record)
    valid_images = [img for img in record.images if img.valid and not img.duplicate]
    for idx, image in enumerate(valid_images):
        src = Path(image.filepath)
        if not src.is_file():
            continue
        suffix = src.suffix.lower()
        if suffix not in {".jpg", ".jpeg", ".png"}:
            suffix = ".png"
        dest = dataset_dir / f"{idx:03d}{suffix}"
        if src.resolve() != dest.resolve():
            shutil.copy2(src, dest)
        caption = image.final_caption or image.manual_caption or image.auto_caption or record.name
        caption_text = caption if trig in caption else f"{trig}, {caption}"
        dest.with_suffix(".txt").write_text(caption_text.strip(), encoding="utf-8")
    return dataset_dir


def build_lora_config(record: CharacterRecord, dataset_dir: Path, *, container_paths: bool = False) -> Path:
    cfg = get_config().ai_toolkit
    job_dir = training_root() / record.id
    config_dir = job_dir / "config"
    output_dir = job_dir / "output"
    config_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    name = f"character_{record.id}_{record.profile.lower()}"
    steps = max(1, int(profile_steps(record.profile)))
    resolution = max(256, int(profile_resolution(record.profile)))
    dataset_value = to_container_path(dataset_dir, record) if container_paths else str(dataset_dir)
    output_value = to_container_path(output_dir, record) if container_paths else str(output_dir)

    # Calculate dynamic save_every based on profile steps
    if steps <= 600:
        save_every = 200
    elif steps <= 1500:
        save_every = 350
    else:
        save_every = 500
    save_every = min(save_every, steps)

    payload = {
        "job": "extension",
        "config": {
            "name": name,
            "process": [
                {
                    "type": "sd_trainer",
                    "training_folder": output_value,
                    "device": cfg.device,
                    "trigger_word": trigger_word(record),
                    "network": {
                        "type": "lora",
                        "linear": 32,
                        "linear_alpha": 32,
                    },
                    "save": {
                        "dtype": "float16",
                        "save_every": save_every,
                        "max_step_saves_to_keep": 20,
                    },
                    "datasets": [
                        {
                            "folder_path": dataset_value,
                            "caption_ext": "txt",
                            "caption_dropout_rate": 0.05,
                            "shuffle_tokens": False,
                            "cache_latents_to_disk": True,
                            "resolution": [resolution],
                        }
                    ],
                    "train": {
                        "batch_size": 1,
                        "steps": steps,
                        "gradient_accumulation": 1,
                        "train_unet": True,
                        "train_text_encoder": False,
                        "gradient_checkpointing": True,
                        "noise_scheduler": "flowmatch",
                        "optimizer": "adamw8bit",
                        "lr": 0.0001,
                    },
                    "model": {
                        "name_or_path": cfg.base_model,
                        "arch": cfg.model_arch,
                        "quantize": True,
                        "quantize_te": True,
                        "low_vram": True,
                        "layer_offloading": True,
                    },
                    "sample": {
                        "sample_every": save_every,
                        "width": resolution,
                        "height": resolution,
                        "prompts": [f"{trigger_word(record)}, cinematic portrait"],
                        "seed": 42,
                        "sample_steps": 8,
                        "guidance_scale": 3.5,
                    },
                }
            ],
        },
        "meta": {"name": "[name]"},
    }
    config_path = config_dir / f"{name}.yaml"
    config_path.write_text(yaml.safe_dump(payload, sort_keys=False, allow_unicode=True), encoding="utf-8")
    return config_path


def build_continue_lora_config(
    record: "CharacterRecord",
    checkpoint_path: Path,
    additional_steps: int,
    cont_index: int = 1,
    lr: float = 5e-5,
    noise_offset: Optional[float] = None,
) -> Path:
    """Build a YAML config for continuing training from an existing checkpoint."""
    cfg = get_config().ai_toolkit
    job_dir = training_root() / record.id
    config_dir = job_dir / "config"
    output_dir = job_dir / "output"
    config_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    base_name = f"character_{record.id}_{record.profile.lower()}"
    cont_name = f"{base_name}_cont{cont_index}"
    resolution = max(256, int(profile_resolution(record.profile)))

    save_every = 250
    if additional_steps <= 600:
        save_every = 200
    elif additional_steps <= 1500:
        save_every = 350
    else:
        save_every = 500
    save_every = min(save_every, additional_steps)

    # Look for optimizer.pt from the previous run (enables better optimizer state restore)
    optimizer_path = output_dir / base_name / "optimizer.pt"

    payload = {
        "job": "extension",
        "config": {
            "name": cont_name,
            "process": [
                {
                    "type": "sd_trainer",
                    "training_folder": str(output_dir),
                    "device": cfg.device,
                    "trigger_word": trigger_word(record),
                    "network": {
                        "type": "lora",
                        "linear": 32,
                        "linear_alpha": 32,
                        "init_lora": str(checkpoint_path),
                    },
                    "save": {
                        "dtype": "float16",
                        "save_every": save_every,
                        "max_step_saves_to_keep": 20,
                    },
                    "datasets": [
                        {
                            "folder_path": str(training_root() / record.id / "dataset"),
                            "caption_ext": "txt",
                            "caption_dropout_rate": 0.05,
                            "shuffle_tokens": False,
                            "cache_latents_to_disk": True,
                            "resolution": [resolution],
                        }
                    ],
                    "train": {
                        "batch_size": 1,
                        "steps": additional_steps,
                        "gradient_accumulation": 1,
                        "train_unet": True,
                        "train_text_encoder": False,
                        "gradient_checkpointing": True,
                        "noise_scheduler": "flowmatch",
                        "optimizer": "adamw8bit",
                        "lr": lr,
                        **({"noise_offset": noise_offset} if noise_offset is not None else {}),
                    },
                    "model": {
                        "name_or_path": cfg.base_model,
                        "arch": cfg.model_arch,
                        "quantize": True,
                        "quantize_te": True,
                        "low_vram": True,
                        "layer_offloading": True,
                    },
                    "sample": {
                        "sample_every": save_every,
                        "width": resolution,
                        "height": resolution,
                        "prompts": [f"{trigger_word(record)}, cinematic portrait"],
                        "seed": 42,
                        "sample_steps": 8,
                        "guidance_scale": 3.5,
                    },
                }
            ],
        },
        "meta": {"name": "[name]"},
    }

    # Add resume if optimizer.pt exists (restores optimizer momentum)
    if optimizer_path.is_file():
        payload["config"]["process"][0]["save"]["resume"] = str(optimizer_path)

    config_path = config_dir / f"{cont_name}.yaml"
    config_path.write_text(yaml.safe_dump(payload, sort_keys=False, allow_unicode=True), encoding="utf-8")
    return config_path


async def run_continue_lora(
    record: "CharacterRecord",
    checkpoint_path: Path,
    additional_steps: int,
    cont_index: int = 1,
    lr: float = 5e-5,
    noise_offset: Optional[float] = None,
    phase_name: str = "",
) -> "AiToolkitRunResult":
    """Continue training from a checkpoint for additional_steps."""
    from src.core.workflow.character_service import save_record

    cfg = get_config().ai_toolkit
    config_path = build_continue_lora_config(
        record, checkpoint_path, additional_steps, cont_index,
        lr=lr, noise_offset=noise_offset,
    )
    output_dir = training_root() / record.id / "output"

    if cfg.backend == "docker":
        return AiToolkitRunResult(
            ok=False,
            status="unsupported",
            command=[],
            config_path=str(config_path),
            dataset_dir="",
            output_dir=str(output_dir),
            error="Continue training non supportato in modalità Docker",
        )

    toolkit_dir = discover_toolkit_dir()
    python_exe = cfg.python_executable or sys.executable
    command = [python_exe, "run.py", str(config_path)]

    if toolkit_dir is None:
        return AiToolkitRunResult(
            ok=False,
            status="missing",
            command=command,
            config_path=str(config_path),
            dataset_dir="",
            output_dir=str(output_dir),
            error="ai-toolkit non trovato",
        )

    proc = await create_subprocess_exec_compatible(
        command[0],
        *command[1:],
        cwd=str(toolkit_dir),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    _ACTIVE_PROCESSES[record.id] = proc
    record.status = "in_creazione"
    record.progress = 0
    phase_label = f" [{phase_name}]" if phase_name else ""
    record.logs.append(f"Continuazione training{phase_label} (cont{cont_index}, {additional_steps} step, lr={lr})")
    save_record(record)

    try:
        stdout_text, stderr_text = await stream_subprocess_logs(proc, record)
        await proc.wait()
    finally:
        _ACTIVE_PROCESSES.pop(record.id, None)

    lora = find_lora_output(output_dir)
    ok = proc.returncode == 0
    record.status = "completato" if ok else "errore"
    record.progress = 100 if ok else record.progress
    if not ok:
        record.error = f"Continuazione training fallita (exit {proc.returncode})"
    save_record(record)

    return AiToolkitRunResult(
        ok=ok,
        status="completed" if ok else "failed",
        command=command,
        config_path=str(config_path),
        dataset_dir="",
        output_dir=str(output_dir),
        lora_path=str(lora) if lora else None,
        stdout_tail=stdout_text[-2000:],
        stderr_tail=stderr_text[-2000:],
        error=None if ok else f"exit code {proc.returncode}",
    )


def create_remote_bundle(record: CharacterRecord) -> Path:
    job_dir = training_root() / record.id
    zip_path = job_dir / f"ai_toolkit_{record.id}.zip"
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for sub in ("config", "dataset", "output"):
            base = job_dir / sub
            if not base.exists():
                continue
            for path in base.rglob("*"):
                if path.is_file():
                    zf.write(path, path.relative_to(job_dir).as_posix())
    return zip_path


def find_lora_output(output_dir: Path) -> Optional[Path]:
    candidates = sorted(
        list(output_dir.rglob("*.safetensors")) + list(output_dir.rglob("*.pt")),
        key=lambda p: p.stat().st_mtime if p.exists() else 0,
        reverse=True,
    )
    return candidates[0] if candidates else None


class WindowsSubprocessBridge:
    def __init__(self, command: list[str], cwd: Optional[str] = None):
        self.command = command
        self.cwd = cwd
        self.proc = None
        self.returncode = None

    def start(self):
        import subprocess
        # Avoid showing terminal windows on Windows
        startupinfo = None
        if os.name == 'nt':
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE

        self.proc = subprocess.Popen(
            self.command,
            cwd=self.cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            startupinfo=startupinfo,
        )

    def terminate(self):
        if self.proc:
            try:
                self.proc.terminate()
            except Exception:
                pass

    async def wait(self) -> int:
        if self.proc:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, self.proc.wait)
            self.returncode = self.proc.returncode
            return self.returncode
        return -1

    async def communicate(self, timeout=None) -> tuple[bytes, bytes]:
        if self.proc:
            loop = asyncio.get_running_loop()
            if timeout:
                try:
                    stdout, stderr = await asyncio.wait_for(
                        loop.run_in_executor(None, self.proc.communicate),
                        timeout=timeout
                    )
                except asyncio.TimeoutError:
                    self.terminate()
                    raise
            else:
                stdout, stderr = await loop.run_in_executor(None, self.proc.communicate)
            self.returncode = self.proc.returncode
            return stdout, stderr
        return b"", b""


class CompatibleProcess:
    def __init__(self, proc, is_fallback: bool = False, bridge: Optional[WindowsSubprocessBridge] = None):
        self.proc = proc
        self.is_fallback = is_fallback
        self.bridge = bridge

    @property
    def returncode(self) -> Optional[int]:
        if self.is_fallback:
            return self.bridge.returncode if self.bridge else None
        return self.proc.returncode

    @property
    def stdout(self):
        return self.proc.stdout if not self.is_fallback else None

    @property
    def stderr(self):
        return self.proc.stderr if not self.is_fallback else None

    def terminate(self):
        if self.is_fallback:
            if self.bridge:
                self.bridge.terminate()
        else:
            self.proc.terminate()

    async def wait(self) -> int:
        if self.is_fallback:
            if self.bridge:
                return await self.bridge.wait()
            return -1
        else:
            await self.proc.wait()
            return self.proc.returncode

    async def communicate(self, timeout=None) -> tuple[bytes, bytes]:
        if self.is_fallback:
            if self.bridge:
                return await self.bridge.communicate(timeout=timeout)
            return b"", b""
        else:
            if timeout:
                return await asyncio.wait_for(self.proc.communicate(), timeout=timeout)
            return await self.proc.communicate()


async def create_subprocess_exec_compatible(
    program: str,
    *args: str,
    cwd: Optional[str] = None,
    stdout=None,
    stderr=None,
) -> CompatibleProcess:
    command = [program] + list(args)
    try:
        proc = await asyncio.create_subprocess_exec(
            program,
            *args,
            cwd=cwd,
            stdout=stdout,
            stderr=stderr,
        )
        return CompatibleProcess(proc, is_fallback=False)
    except NotImplementedError:
        # Fallback for Windows SelectorEventLoopPolicy
        bridge = WindowsSubprocessBridge(command, cwd=cwd)
        bridge.start()
        return CompatibleProcess(None, is_fallback=True, bridge=bridge)


def parse_and_update_progress(text: str, record: CharacterRecord) -> None:
    import re
    # Match tqdm or other step patterns, e.g. " 150/1000 [" or "step 250/1000" or "Step: 250"
    match = re.search(r'\b(\d+)/(\d+)\b', text)
    curr = None
    total = None
    if match:
        try:
            curr, total = int(match.group(1)), int(match.group(2))
            if curr < 0 or curr > total or total <= 10:
                curr = None
                total = None
        except Exception:
            curr = None
            total = None

    if curr is None:
        match_step = re.search(r'\bstep\s*:?\s*(\d+)\b', text, re.IGNORECASE)
        if match_step:
            try:
                curr = int(match_step.group(1))
                total = record.config.get("training_steps", 600)
            except Exception:
                curr = None

    if curr is not None and curr >= 0:
        total = total or record.config.get("training_steps", 600)
        record.config["ai_toolkit_current_step"] = curr
        record.config["ai_toolkit_total_steps"] = total

        # Map training progress (15% to 95%)
        pct = min(1.0, curr / total) if total > 0 else 0.0
        record.progress = 15 + int(pct * 80)


async def stream_subprocess_logs(proc, record: CharacterRecord) -> tuple[str, str]:
    """Stream subprocess logs from proc.stdout and proc.stderr, updating record.logs and saving periodically."""
    import time
    from src.core.workflow.character_service import save_record

    last_save_time = time.time()
    stdout_tail_lines = []
    stderr_tail_lines = []

    if hasattr(proc, "is_fallback") and proc.is_fallback:
        bridge = proc.bridge
        loop = asyncio.get_running_loop()
        import threading

        def thread_reader(stream, is_stderr: bool):
            nonlocal last_save_time
            # Standard readline loop
            for line in iter(stream.readline, b""):
                text = line.decode("utf-8", errors="replace").rstrip()
                if text:
                    prefix = "[ai-toolkit/stderr]" if is_stderr else "[ai-toolkit]"

                    def update(t=text, pref=prefix, err=is_stderr):
                        nonlocal last_save_time
                        if err:
                            stderr_tail_lines.append(t)
                            if len(stderr_tail_lines) > 100:
                                stderr_tail_lines.pop(0)
                        else:
                            stdout_tail_lines.append(t)
                            if len(stdout_tail_lines) > 100:
                                stdout_tail_lines.pop(0)

                        record.logs.append(f"{pref} {t}")
                        if len(record.logs) > 1000:
                            record.logs.pop(0)

                        if not err:
                            parse_and_update_progress(t, record)

                        now = time.time()
                        if now - last_save_time >= 1.5:
                            save_record(record)
                            last_save_time = now

                    loop.call_soon_threadsafe(update)

        t_out = threading.Thread(target=thread_reader, args=(bridge.proc.stdout, False), daemon=True)
        t_err = threading.Thread(target=thread_reader, args=(bridge.proc.stderr, True), daemon=True)
        t_out.start()
        t_err.start()

        await proc.wait()
        await loop.run_in_executor(None, t_out.join)
        await loop.run_in_executor(None, t_err.join)
        save_record(record)
        return "\n".join(stdout_tail_lines), "\n".join(stderr_tail_lines)

    async def read_stream(stream, is_stderr: bool):
        nonlocal last_save_time
        while True:
            line = await stream.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                prefix = "[ai-toolkit/stderr]" if is_stderr else "[ai-toolkit]"
                if is_stderr:
                    stderr_tail_lines.append(text)
                    if len(stderr_tail_lines) > 100:
                        stderr_tail_lines.pop(0)
                else:
                    stdout_tail_lines.append(text)
                    if len(stdout_tail_lines) > 100:
                        stdout_tail_lines.pop(0)

                record.logs.append(f"{prefix} {text}")
                if len(record.logs) > 1000:
                    record.logs.pop(0)

                if not is_stderr:
                    parse_and_update_progress(text, record)

                now = time.time()
                if now - last_save_time >= 1.5:
                    save_record(record)
                    last_save_time = now

    await asyncio.gather(
        read_stream(proc.stdout, False),
        read_stream(proc.stderr, True),
    )
    save_record(record)
    return "\n".join(stdout_tail_lines), "\n".join(stderr_tail_lines)



async def run_lora_start(record: CharacterRecord, smoke_test: bool = False) -> AiToolkitRunResult:
    # Prevent PyTorch CUDA memory fragmentation under constrained VRAM
    os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"

    cfg = get_config().ai_toolkit
    dataset_dir = prepare_dataset(record)
    config_path = build_lora_config(record, dataset_dir, container_paths=cfg.backend == "docker")
    output_dir = training_root() / record.id / "output"
    command: list[str] = []

    if cfg.mode == "disabled":
        return AiToolkitRunResult(
            ok=False,
            status="disabled",
            command=command,
            config_path=str(config_path),
            dataset_dir=str(dataset_dir),
            output_dir=str(output_dir),
            error="ai-toolkit disabilitato in configurazione",
        )

    if cfg.backend == "remote":
        return await run_remote_lora(record, config_path, dataset_dir, output_dir, smoke_test=smoke_test)

    if cfg.backend == "docker":
        return await run_docker_lora(record, config_path, dataset_dir, output_dir, smoke_test=smoke_test)

    return await run_local_lora(record, config_path, dataset_dir, output_dir, smoke_test=smoke_test)


async def run_local_lora(
    record: CharacterRecord,
    config_path: Path,
    dataset_dir: Path,
    output_dir: Path,
    smoke_test: bool = False,
) -> AiToolkitRunResult:
    cfg = get_config().ai_toolkit
    toolkit_dir = discover_toolkit_dir()
    python_exe = cfg.python_executable or sys.executable
    command = [python_exe, "run.py", str(config_path)]
    if toolkit_dir is None:
        return AiToolkitRunResult(
            ok=False,
            status="missing",
            command=command,
            config_path=str(config_path),
            dataset_dir=str(dataset_dir),
            output_dir=str(output_dir),
            error="ai-toolkit non trovato: configura ai_toolkit.toolkit_dir o AI_TOOLKIT_DIR",
        )
    proc = await create_subprocess_exec_compatible(
        command[0],
        *command[1:],
        cwd=str(toolkit_dir),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    if smoke_test:
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=max(5, cfg.max_start_seconds))
        except asyncio.TimeoutError:
            proc.terminate()
            lora = find_lora_output(output_dir)
            return AiToolkitRunResult(
                ok=True,
                status="started",
                command=command,
                config_path=str(config_path),
                dataset_dir=str(dataset_dir),
                output_dir=str(output_dir),
                lora_path=str(lora) if lora else None,
                stdout_tail="Processo avviato; interrotto dal controllo smoke per non bloccare l'app.",
            )

        stdout_text = stdout.decode("utf-8", errors="replace")[-4000:] if stdout else ""
        stderr_text = stderr.decode("utf-8", errors="replace")[-4000:] if stderr else ""
        lora = find_lora_output(output_dir)
        ok = proc.returncode == 0 and lora is not None
        return AiToolkitRunResult(
            ok=ok,
            status="completed" if ok else "failed",
            command=command,
            config_path=str(config_path),
            dataset_dir=str(dataset_dir),
            output_dir=str(output_dir),
            lora_path=str(lora) if lora else None,
            stdout_tail=stdout_text,
            stderr_tail=stderr_text,
            error=None if ok else f"ai-toolkit exit code {proc.returncode}",
        )
    else:
        # Stream logs in real-time and wait to completion
        _ACTIVE_PROCESSES[record.id] = proc
        try:
            stdout_text, stderr_text = await stream_subprocess_logs(proc, record)
            await proc.wait()
        finally:
            _ACTIVE_PROCESSES.pop(record.id, None)

        lora = find_lora_output(output_dir)
        ok = proc.returncode == 0 and lora is not None
        return AiToolkitRunResult(
            ok=ok,
            status="completed" if ok else "failed",
            command=command,
            config_path=str(config_path),
            dataset_dir=str(dataset_dir),
            output_dir=str(output_dir),
            lora_path=str(lora) if lora else None,
            stdout_tail=stdout_text,
            stderr_tail=stderr_text,
            error=None if ok else f"ai-toolkit exit code {proc.returncode}",
        )


async def run_docker_lora(
    record: CharacterRecord,
    config_path: Path,
    dataset_dir: Path,
    output_dir: Path,
    smoke_test: bool = False,
) -> AiToolkitRunResult:
    cfg = get_config().ai_toolkit
    train_root = training_root()
    hf_cache = Path(cfg.docker_hf_cache).expanduser() if cfg.docker_hf_cache else Path.home() / ".cache" / "huggingface"
    hf_cache.mkdir(parents=True, exist_ok=True)
    container_config = to_container_path(config_path, record)
    container_name = f"aidirector-ai_toolkit_{record.id}"
    command = ["docker", "run", "--rm", "--name", container_name, "--network", "aidirector"]
    if cfg.docker_gpus:
        command.extend(["--gpus", cfg.docker_gpus])
    command.extend([
        "-e", "HF_HOME=/root/.cache/huggingface",
        "-e", "HF_HUB_ENABLE_HF_TRANSFER=1",
        "-e", "PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True",
    ])
    # Pass HuggingFace API Token (prioritizing the one from app settings, with fallback to environment variables)
    hf_token = cfg.hf_token or os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if hf_token:
        command.extend([
            "-e", f"HF_TOKEN={hf_token}",
            "-e", f"HUGGING_FACE_HUB_TOKEN={hf_token}",
        ])
    command.extend([
        "-v", f"{train_root}:/workspace/training",
        "-v", f"{hf_cache}:/root/.cache/huggingface",
    ])
    if cfg.docker_workdir:
        command.extend(["--workdir", cfg.docker_workdir])
    command.extend([cfg.docker_image, container_config])

    if not docker_available():
        return AiToolkitRunResult(
            ok=False,
            status="missing",
            command=command,
            config_path=str(config_path),
            dataset_dir=str(dataset_dir),
            output_dir=str(output_dir),
            error="Docker non trovato nel PATH",
        )

    proc = await create_subprocess_exec_compatible(
        command[0],
        *command[1:],
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    if smoke_test:
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=max(5, cfg.max_start_seconds))
        except asyncio.TimeoutError:
            proc.terminate()
            lora = find_lora_output(output_dir)
            return AiToolkitRunResult(
                ok=True,
                status="started",
                command=command,
                config_path=str(config_path),
                dataset_dir=str(dataset_dir),
                output_dir=str(output_dir),
                lora_path=str(lora) if lora else None,
                stdout_tail="Container avviato; smoke test fermato prima della fine training.",
            )

        stdout_text = stdout.decode("utf-8", errors="replace")[-4000:] if stdout else ""
        stderr_text = stderr.decode("utf-8", errors="replace")[-4000:] if stderr else ""
        lora = find_lora_output(output_dir)
        ok = proc.returncode == 0 and lora is not None
        return AiToolkitRunResult(
            ok=ok,
            status="completed" if ok else "failed",
            command=command,
            config_path=str(config_path),
            dataset_dir=str(dataset_dir),
            output_dir=str(output_dir),
            lora_path=str(lora) if lora else None,
            stdout_tail=stdout_text,
            stderr_tail=stderr_text,
            error=None if ok else f"ai-toolkit docker exit code {proc.returncode}",
        )
    else:
        # Stream logs in real-time and wait to completion
        _ACTIVE_PROCESSES[record.id] = proc
        try:
            stdout_text, stderr_text = await stream_subprocess_logs(proc, record)
            await proc.wait()
        finally:
            _ACTIVE_PROCESSES.pop(record.id, None)

        lora = find_lora_output(output_dir)
        ok = proc.returncode == 0 and lora is not None
        return AiToolkitRunResult(
            ok=ok,
            status="completed" if ok else "failed",
            command=command,
            config_path=str(config_path),
            dataset_dir=str(dataset_dir),
            output_dir=str(output_dir),
            lora_path=str(lora) if lora else None,
            stdout_tail=stdout_text,
            stderr_tail=stderr_text,
            error=None if ok else f"ai-toolkit docker exit code {proc.returncode}",
        )


async def run_remote_lora(
    record: CharacterRecord,
    config_path: Path,
    dataset_dir: Path,
    output_dir: Path,
    smoke_test: bool = False,
) -> AiToolkitRunResult:
    cfg = get_config().ai_toolkit
    command = ["POST", cfg.remote_url or ""]
    if not cfg.remote_url:
        return AiToolkitRunResult(
            ok=False,
            status="missing",
            command=command,
            config_path=str(config_path),
            dataset_dir=str(dataset_dir),
            output_dir=str(output_dir),
            error="remote_url non configurato per ai-toolkit remote",
        )
    bundle_path = create_remote_bundle(record)
    headers = {}
    if cfg.remote_api_key:
        headers["Authorization"] = f"Bearer {cfg.remote_api_key}"
    payload = {
        "character_id": record.id,
        "name": record.name,
        "profile": record.profile,
        "trigger_word": trigger_word(record),
        "config_path": str(config_path.name),
    }
    try:
        async with httpx.AsyncClient(timeout=max(10, cfg.max_start_seconds)) as client:
            with bundle_path.open("rb") as fh:
                res = await client.post(
                    cfg.remote_url,
                    headers=headers,
                    data={"config": yaml.safe_dump(payload, sort_keys=False)},
                    files={"bundle": (bundle_path.name, fh, "application/zip")},
                )
        data = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}
        if res.status_code >= 400:
            return AiToolkitRunResult(
                ok=False,
                status="failed",
                command=command,
                config_path=str(config_path),
                dataset_dir=str(dataset_dir),
                output_dir=str(output_dir),
                error=f"remote ai-toolkit HTTP {res.status_code}: {res.text[-1000:]}",
            )
        lora_path = data.get("lora_path")
        status = data.get("status") or ("completed" if lora_path else "started")
        return AiToolkitRunResult(
            ok=True,
            status=status,
            command=command,
            config_path=str(config_path),
            dataset_dir=str(dataset_dir),
            output_dir=str(output_dir),
            lora_path=lora_path,
            stdout_tail=str(data.get("message") or data)[:4000],
        )
    except Exception as exc:
        return AiToolkitRunResult(
            ok=False,
            status="failed",
            command=command,
            config_path=str(config_path),
            dataset_dir=str(dataset_dir),
            output_dir=str(output_dir),
            error=str(exc),
        )


async def pause_training_process(character_id: str) -> bool:
    import psutil
    cfg = get_config().ai_toolkit

    # If Docker backend, we also pause the container
    if cfg.backend == "docker":
        try:
            import subprocess
            subprocess.run(["docker", "pause", f"aidirector-ai_toolkit_{character_id}"], capture_output=True, check=True)
        except Exception as e:
            print(f"Error pausing docker container: {e}")

    # Also suspend the local subprocess (which reads logs/handles wait)
    proc = _ACTIVE_PROCESSES.get(character_id)
    if not proc:
        return False
    try:
        if proc.is_fallback:
            pid = proc.bridge.proc.pid
        else:
            pid = proc.proc.pid

        p = psutil.Process(pid)
        p.suspend()
        return True
    except Exception as e:
        print(f"Error suspending process: {e}")
        return False


async def resume_training_process(character_id: str) -> bool:
    import psutil
    cfg = get_config().ai_toolkit

    # Resume the local subprocess first
    proc = _ACTIVE_PROCESSES.get(character_id)
    if not proc:
        return False
    try:
        if proc.is_fallback:
            pid = proc.bridge.proc.pid
        else:
            pid = proc.proc.pid

        p = psutil.Process(pid)
        p.resume()
    except Exception as e:
        print(f"Error resuming process: {e}")
        return False

    # If Docker backend, we also unpause the container
    if cfg.backend == "docker":
        try:
            import subprocess
            subprocess.run(["docker", "unpause", f"aidirector-ai_toolkit_{character_id}"], capture_output=True, check=True)
        except Exception as e:
            print(f"Error unpausing docker container: {e}")

    return True
