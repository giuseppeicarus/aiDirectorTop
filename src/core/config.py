"""
Caricamento configurazione da YAML con override da variabili d'ambiente.
Percorso config: ~/.cinematic-studio/config.yaml (override su config/default.yaml)
"""

import os
import re
from functools import lru_cache
from pathlib import Path
from typing import List, Optional

import yaml
from pydantic import BaseModel, Field


# ── Modelli configurazione ────────────────────────────────────────────────────

class AppConfig(BaseModel):
    version: str = "1.0.0"
    data_dir: str = "~/.cinematic-studio"
    log_level: str = "INFO"
    backend_port: int = 8765

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


class ComfyUINodeConfig(BaseModel):
    host: str = "localhost"
    port: int = 8188
    name: str = "Local GPU"
    enabled: bool = True
    auth: Optional[str] = None  # "user:password" se necessario

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    @property
    def ws_url(self) -> str:
        return f"ws://{self.host}:{self.port}/ws"


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


class AppSettings(BaseModel):
    app: AppConfig = Field(default_factory=AppConfig)
    llm: LLMConfig = Field(default_factory=LLMConfig)
    llm_roles: dict[str, LLMConfig] = Field(default_factory=dict)
    comfyui: ComfyUIConfig = Field(default_factory=ComfyUIConfig)
    generation: GenerationConfig = Field(default_factory=GenerationConfig)
    output: OutputConfig = Field(default_factory=OutputConfig)

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
            return self.llm.model_copy(update={
                "temperature": role_cfg.temperature,
                "max_tokens":  role_cfg.max_tokens,
            })
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
