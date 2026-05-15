"""Tests per il caricamento configurazione e risoluzione env vars."""

import pytest
import yaml

from src.core.config import AppSettings, get_config, reload_config


def _make_config(tmp_path, data: dict) -> AppSettings:
    cfg_file = tmp_path / "config.yaml"
    cfg_file.write_text(yaml.dump(data))
    import src.core.config as _cfg_module
    _cfg_module.get_config.cache_clear()
    original_load = _cfg_module._load_yaml

    def patched_load(path):
        if "default" in str(path):
            return {}
        return original_load(path)

    import unittest.mock as mock
    with mock.patch.object(_cfg_module, "_load_yaml", side_effect=lambda p: data if str(p) == str(cfg_file) else {}):
        _cfg_module.get_config.cache_clear()
        # Costruiamo direttamente AppSettings dai dati
        pass

    return AppSettings(**data)


def test_default_settings():
    cfg = AppSettings()
    assert cfg.app.backend_port == 8765
    assert cfg.llm.temperature == 0.7
    assert cfg.comfyui.execution_timeout_sec == 300
    assert cfg.llm_roles == {}


def test_yaml_overrides(tmp_path, monkeypatch):
    import src.core.config as _cfg_module
    data = {
        "app": {"backend_port": 9999, "log_level": "DEBUG"},
        "llm": {"provider": "anthropic", "model": "claude-opus-4-7"},
    }
    cfg_file = tmp_path / "config.yaml"
    cfg_file.write_text(yaml.dump(data))

    monkeypatch.setattr(_cfg_module, "_load_yaml", lambda p: data if "default" in str(p) else {})
    _cfg_module.get_config.cache_clear()
    cfg = _cfg_module.get_config()

    assert cfg.app.backend_port == 9999
    assert cfg.llm.provider == "anthropic"
    assert cfg.llm.temperature == 0.7  # default mantenuto


def test_env_var_resolution(tmp_path, monkeypatch):
    import src.core.config as _cfg_module
    monkeypatch.setenv("TEST_API_KEY_CINEMATIC", "sk-test-1234")
    data = {"llm": {"api_key": "${TEST_API_KEY_CINEMATIC}"}}
    monkeypatch.setattr(_cfg_module, "_load_yaml", lambda p: data if "default" in str(p) else {})
    _cfg_module.get_config.cache_clear()
    cfg = _cfg_module.get_config()
    assert cfg.llm.api_key == "sk-test-1234"


def test_missing_env_var_becomes_none(tmp_path, monkeypatch):
    import src.core.config as _cfg_module
    monkeypatch.delenv("NONEXISTENT_VAR_XYZ_CINEMATIC", raising=False)
    data = {"llm": {"api_key": "${NONEXISTENT_VAR_XYZ_CINEMATIC}"}}
    monkeypatch.setattr(_cfg_module, "_load_yaml", lambda p: data if "default" in str(p) else {})
    _cfg_module.get_config.cache_clear()
    cfg = _cfg_module.get_config()
    # Variabile mancante → None (comportamento attuale della config)
    assert cfg.llm.api_key is None


def test_data_path_expands_home():
    cfg = AppSettings()
    assert not str(cfg.app.data_path).startswith("~")
    assert cfg.app.data_path.is_absolute()


def test_multiple_comfyui_nodes():
    cfg = AppSettings(**{
        "comfyui": {
            "nodes": [
                {"host": "10.0.0.1", "port": 8188, "name": "GPU-1", "enabled": True},
                {"host": "10.0.0.2", "port": 8188, "name": "GPU-2", "enabled": False},
            ]
        }
    })
    assert len(cfg.comfyui.nodes) == 2
    assert cfg.comfyui.nodes[0].name == "GPU-1"
    assert cfg.comfyui.nodes[1].enabled is False


def test_llm_roles_field():
    cfg = AppSettings(**{
        "llm_roles": {
            "story_analyst": {"provider": "openai", "model": "gpt-4o", "temperature": 0.85},
            "continuity_checker": {"provider": "openai", "model": "gpt-4o-mini"},
        }
    })
    assert "story_analyst" in cfg.llm_roles
    assert cfg.llm_roles["story_analyst"].temperature == 0.85
    assert cfg.llm_roles["continuity_checker"].model == "gpt-4o-mini"


def test_get_llm_for_role_fallback():
    cfg = AppSettings(**{"llm": {"provider": "ollama", "model": "llama3"}})
    # Ruolo non configurato → fallback al default
    role_cfg = cfg.get_llm_for_role("nonexistent_role")
    assert role_cfg.provider == "ollama"
    assert role_cfg.model == "llama3"


def test_get_llm_for_role_override_with_key():
    """Role with its own api_key uses its own provider."""
    cfg = AppSettings(**{
        "llm": {"provider": "ollama", "model": "llama3"},
        "llm_roles": {"story_analyst": {"provider": "openai", "model": "gpt-4o", "api_key": "sk-test"}},
    })
    role_cfg = cfg.get_llm_for_role("story_analyst")
    assert role_cfg.provider == "openai"
    assert role_cfg.model == "gpt-4o"


def test_get_llm_for_role_fallback_when_no_key():
    """Role without api_key falls back to global provider + credentials."""
    cfg = AppSettings(**{
        "llm": {"provider": "ollama", "model": "llama3", "temperature": 0.7},
        "llm_roles": {"story_analyst": {"provider": "openai", "model": "gpt-4o", "temperature": 0.85}},
    })
    role_cfg = cfg.get_llm_for_role("story_analyst")
    # Falls back to global provider because role has no api_key
    assert role_cfg.provider == "ollama"
    # Inherits role-specific temperature
    assert role_cfg.temperature == 0.85


def test_reload_config():
    import src.core.config as _cfg_module
    _cfg_module.get_config.cache_clear()
    cfg1 = _cfg_module.get_config()
    cfg2 = reload_config()
    assert cfg1.app.version == cfg2.app.version
