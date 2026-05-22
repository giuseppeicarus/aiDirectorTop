"""
Caricamento configurazione da YAML con override da variabili d'ambiente.
Percorso config: ~/.cinematic-studio/config.yaml (override su config/default.yaml)
"""

import os
import re
from functools import lru_cache
from pathlib import Path
from typing import List, Literal, Optional

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator

from src.core.utils.comfyui_node_url import infer_auth_type, normalize_host_port


# ── Modelli configurazione ────────────────────────────────────────────────────

class AppConfig(BaseModel):
    version: str = "1.0.0"
    data_dir: str = "~/.cinematic-studio"
    log_level: str = "INFO"
    backend_port: int = 8123

    @property
    def data_path(self) -> Path:
        return Path(self.data_dir).expanduser()


class LLMConfig(BaseModel):
    provider: str = "openai"
    model: str = "gpt-4o"
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    temperature: float = 0.7
    max_tokens: int = 4096
    timeout_sec: int = 120
    retry_attempts: int = 3
    retry_delay_sec: float = 2.0

    @field_validator("api_key", "base_url", mode="before")
    @classmethod
    def _empty_str_to_none(cls, v: object) -> object:
        if isinstance(v, str) and not v.strip():
            return None
        return v


class ComfyUINodeConfig(BaseModel):
    host: str = "localhost"
    port: int = 8188
    name: str = "Local GPU"
    enabled: bool = True
    primary: bool = False  # nodo preferito; gli altri sono fallback
    auth_type: Literal["none", "token", "basic"] = "none"
    auth: Optional[str] = None   # used when auth_type == "basic" (user:password)
    token: Optional[str] = None  # used when auth_type == "token" (?token=)

    @model_validator(mode="after")
    def _normalize_endpoint(self) -> "ComfyUINodeConfig":
        host, port = normalize_host_port(self.host, self.port)
        object.__setattr__(self, "host", host)
        object.__setattr__(self, "port", port)

        at = infer_auth_type(self.auth_type, token=self.token, auth=self.auth)
        object.__setattr__(self, "auth_type", at)

        if at == "none":
            object.__setattr__(self, "token", None)
            object.__setattr__(self, "auth", None)
        elif at == "token":
            object.__setattr__(self, "auth", None)
            tok = (self.token or "").strip() or None
            object.__setattr__(self, "token", tok)
        elif at == "basic":
            object.__setattr__(self, "token", None)
            basic = (self.auth or "").strip() or None
            object.__setattr__(self, "auth", basic)

        return self

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    @property
    def ws_url(self) -> str:
        return f"ws://{self.host}:{self.port}/ws"

    def query_params(self) -> dict[str, str]:
        if self.auth_type == "token" and self.token:
            return {"token": self.token}
        return {}


class ComfyUIModelsConfig(BaseModel):
    checkpoint: str = "v1-5-pruned-emaonly.ckpt"
    vae: Optional[str] = None
    video: str = "wan2.1_i2v_480p.safetensors"


class ComfyUIConfig(BaseModel):
    nodes: List[ComfyUINodeConfig] = Field(default_factory=lambda: [ComfyUINodeConfig()])
    max_parallel_frame_jobs: int = 4
    max_parallel_video_jobs: int = 2
    queue_timeout_sec: int = 30
    execution_timeout_sec: int = 300
    websocket_recv_timeout_sec: int = 10
    models: ComfyUIModelsConfig = Field(default_factory=ComfyUIModelsConfig)


class FrameGenerationConfig(BaseModel):
    steps: int = 30
    cfg_scale: float = 7.0
    width: int = 1024
    height: int = 576
    sampler: str = "dpm_2_ancestral"
    scheduler: str = "karras"


class GenerationConfig(BaseModel):
    default_genre: str = "cinematic"
    default_style: str = "photorealistic, dramatic lighting, film grain"
    default_aspect_ratio: str = "16:9"
    default_duration_sec: int = 60
    default_num_scenes: int = 3
    frame_generation: FrameGenerationConfig = Field(default_factory=FrameGenerationConfig)
    negative_prompt_default: str = (
        "ugly, deformed, blurry, low quality, watermark, text, bad anatomy, extra limbs"
    )


class OutputConfig(BaseModel):
    default_resolution: dict = Field(default_factory=lambda: {"width": 1920, "height": 1080})
    fps: int = 24
    video_codec: str = "libx264"
    video_crf: int = 18
    video_preset: str = "slow"
    transition_duration_sec: float = 0.5
    transition_type: str = "fade"
    ffmpeg_path: Optional[str] = None


# ── LTX Director 2.3 Configuration ───────────────────────────────────────────

class LTXDirectorSettings(BaseModel):
    """
    Configuration for the LTX Director 2.3 integration (WhatDreamsCost plugin).

    enabled:        Set to True once LTX 2.3 + the WhatDreamsCost ComfyUI plugin
                    are installed and the model files are available in ComfyUI's
                    models directory.
    mode:           "per_shot"   — one LTX Director workflow per CinematicShot
                    "full_video" — one workflow covers the entire video timeline
    """
    enabled: bool = False
    mode: str = "full_video"          # "per_shot" | "full_video"

    # Model file names (must match exactly what is in ComfyUI's models/ folders)
    checkpoint: str = "ltx-video-2b-v0.9.6.safetensors"
    clip_name1: str = "t5xxl_fp16.safetensors"
    clip_name2: str = ""              # empty = no second CLIP
    video_vae: str = "ltx-video-vae-decode-v0.9.6.safetensors"
    audio_vae: str = "ltx-video-2b-v0.9.6.safetensors"
    upscale_model: str = "ltxv_spatial_upscaler_0.9.7.safetensors"
    lora_name: str = ""               # empty = no LoRA
    lora_strength: float = 1.0

    # Sampling parameters
    stage1_steps: int = 8
    stage2_steps: int = 4
    cfg_scale: float = 1.0
    sampler: str = "euler"
    scheduler: str = "linear"
    denoise_stage1: float = 1.0
    denoise_stage2: float = 0.4

    # Output
    frame_rate: int = 24
    width: int = 1280
    height: int = 720

    @field_validator("clip_name2", "lora_name", mode="before")
    @classmethod
    def _none_to_empty(cls, v: object) -> str:
        """
        YAML empty strings ("") are resolved to None by _resolve_env_vars.
        These fields are intentionally optional-but-string (empty = feature off),
        so we coerce None back to "".
        """
        if v is None:
            return ""
        return str(v)


class LanguageConfig(BaseModel):
    ui_language: str = "it"          # ISO 639-1 code shown in UI selector
    llm_language: str = "Italian"    # Full name injected into every LLM system prompt


class ObsidianConfig(BaseModel):
    """Vault Markdown + container Docker (LinuxServer Obsidian)."""
    enabled: bool = True
    vault_dir: str = "obsidian-vault"   # relativo a data_dir se non assoluto
    auto_sync_on_checkpoint: bool = True
    start_docker_on_app_boot: bool = True
    compose_file: str = ""              # vuoto = docker/obsidian/docker-compose.yml nel repo
    web_port: int = 3000
    web_https_port: int = 3001

    @field_validator("compose_file", mode="before")
    @classmethod
    def _compose_file_none(cls, v: object) -> str:
        if v is None:
            return ""
        return str(v)


class AppSettings(BaseModel):
    app: AppConfig = Field(default_factory=AppConfig)
    llm: LLMConfig = Field(default_factory=LLMConfig)
    llm_roles: dict[str, LLMConfig] = Field(default_factory=dict)
    comfyui: ComfyUIConfig = Field(default_factory=ComfyUIConfig)
    generation: GenerationConfig = Field(default_factory=GenerationConfig)
    output: OutputConfig = Field(default_factory=OutputConfig)
    ltx_director: LTXDirectorSettings = Field(default_factory=LTXDirectorSettings)
    obsidian: ObsidianConfig = Field(default_factory=ObsidianConfig)
    language: LanguageConfig = Field(default_factory=LanguageConfig)

    def get_llm_for_role(self, role: str) -> LLMConfig:
        """Restituisce la config LLM per il ruolo specificato, con fallback al default.

        Se il ruolo non ha api_key propria (env var non impostata), eredita provider +
        credenziali dal config llm globale mantenendo solo model/temperature/max_tokens.
        """
        role_cfg = self.llm_roles.get(role)
        if role_cfg is None:
            return self.llm
        # No api_key means env var was not set — fall back to global credentials
        if not role_cfg.api_key:
            updates: dict = {
                "temperature": role_cfg.temperature,
                "max_tokens": role_cfg.max_tokens,
            }
            if role_cfg.model:
                updates["model"] = role_cfg.model
            return self.llm.model_copy(update=updates)
        return role_cfg


# ── Loader ────────────────────────────────────────────────────────────────────

ENV_VAR_RE = re.compile(r"\$\{([^}]+)\}")


def _resolve_env_vars(value: object) -> object:
    """Sostituisce ${VAR} con il valore della variabile d'ambiente."""
    if isinstance(value, str):
        def replace(m: re.Match) -> str:
            return os.environ.get(m.group(1), "")
        return ENV_VAR_RE.sub(replace, value) or None
    if isinstance(value, dict):
        return {k: _resolve_env_vars(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve_env_vars(i) for i in value]
    return value


def _load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _deep_merge(base: dict, override: dict) -> dict:
    result = base.copy()
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(result.get(k), dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result


@lru_cache(maxsize=1)
def get_config() -> AppSettings:
    """Carica e restituisce la configurazione (singleton con cache)."""
    project_root = Path(__file__).parent.parent.parent
    default_path = project_root / "config" / "default.yaml"
    user_path = Path("~/.cinematic-studio/config.yaml").expanduser()

    base = _load_yaml(default_path)
    user = _load_yaml(user_path)
    merged = _deep_merge(base, user)
    resolved = _resolve_env_vars(merged)

    return AppSettings(**resolved)


def reload_config() -> AppSettings:
    """Forza il ricaricamento della configurazione (svuota la cache)."""
    get_config.cache_clear()
    return get_config()


def get_ltx_director_config():
    """
    Return the LTXDirectorConfig dataclass populated from AppSettings.

    Import is deferred to avoid circular imports; safe to call from anywhere.
    """
    from src.core.comfyui.ltx_director_builder import LTXDirectorConfig

    settings = get_config().ltx_director
    return LTXDirectorConfig(
        checkpoint     = settings.checkpoint,
        clip_name1     = settings.clip_name1,
        clip_name2     = settings.clip_name2,
        video_vae      = settings.video_vae,
        audio_vae      = settings.audio_vae,
        upscale_model  = settings.upscale_model,
        lora_name      = settings.lora_name,
        lora_strength  = settings.lora_strength,
        stage1_steps   = settings.stage1_steps,
        stage2_steps   = settings.stage2_steps,
        cfg_scale      = settings.cfg_scale,
        sampler        = settings.sampler,
        scheduler      = settings.scheduler,
        denoise_stage1 = settings.denoise_stage1,
        denoise_stage2 = settings.denoise_stage2,
        frame_rate     = settings.frame_rate,
    )


def save_roles_config(roles_data: dict) -> None:
    """Scrive llm_roles nel file config utente (~/.cinematic-studio/config.yaml)."""
    user_path = Path("~/.cinematic-studio/config.yaml").expanduser()
    user_path.parent.mkdir(parents=True, exist_ok=True)

    existing: dict = {}
    if user_path.exists():
        with open(user_path, encoding="utf-8") as f:
            existing = yaml.safe_load(f) or {}

    existing["llm_roles"] = roles_data

    with open(user_path, "w", encoding="utf-8") as f:
        yaml.dump(existing, f, default_flow_style=False, allow_unicode=True)

    reload_config()


def save_language_config(data: dict) -> None:
    """Scrive la configurazione lingua nel file config utente."""
    user_path = Path("~/.cinematic-studio/config.yaml").expanduser()
    user_path.parent.mkdir(parents=True, exist_ok=True)
    existing: dict = {}
    if user_path.exists():
        with open(user_path, encoding="utf-8") as f:
            existing = yaml.safe_load(f) or {}
    existing["language"] = data
    with open(user_path, "w", encoding="utf-8") as f:
        yaml.dump(existing, f, default_flow_style=False, allow_unicode=True)
    reload_config()


def save_llm_config(llm_data: dict) -> None:
    """Scrive la configurazione LLM globale nel file config utente."""
    user_path = Path("~/.cinematic-studio/config.yaml").expanduser()
    user_path.parent.mkdir(parents=True, exist_ok=True)

    existing: dict = {}
    if user_path.exists():
        with open(user_path, encoding="utf-8") as f:
            existing = yaml.safe_load(f) or {}

    existing["llm"] = llm_data

    with open(user_path, "w", encoding="utf-8") as f:
        yaml.dump(existing, f, default_flow_style=False, allow_unicode=True)

    reload_config()
