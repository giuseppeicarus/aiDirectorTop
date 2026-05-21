"""Test creazione cartelle progetto."""

from pathlib import Path

import pytest

from src.core.config import AppConfig, AppSettings
from src.core.utils import project_paths


@pytest.fixture
def data_root(tmp_path: Path, monkeypatch):
    settings = AppSettings(app=AppConfig(data_dir=str(tmp_path / "studio")))
    monkeypatch.setattr(project_paths, "get_config", lambda: settings)
    return tmp_path / "studio"


def test_ensure_project_directory_creates_subdirs(data_root: Path):
    base = project_paths.ensure_project_directory("abc-123", title="Il mio film")
    assert base.is_dir()
    for name in project_paths.PROJECT_SUBDIRS:
        assert (base / name).is_dir(), f"missing {name}"
    meta = base / "project.json"
    assert meta.is_file()
    assert "Il mio film" in meta.read_text(encoding="utf-8")
    assert (data_root / "projects" / "abc-123").resolve() == base.resolve()


def test_projects_root_created_automatically(data_root: Path):
    root = project_paths.projects_root()
    assert root == data_root / "projects"
    assert root.is_dir()


def test_trailer_storage_id_unique_per_job():
    assert project_paths.resolve_trailer_storage_project_id("trailer_standalone", "abc123") == "trailer_abc123"
    assert project_paths.resolve_trailer_storage_project_id("trailer", "xyz") == "trailer_xyz"
    assert project_paths.resolve_trailer_storage_project_id(
        "c7331712-e567-47ee-b2e9-fc74d5e5b565", "abc",
    ) == "c7331712-e567-47ee-b2e9-fc74d5e5b565"
    assert project_paths.trailer_catalog_project_id("trailer_standalone") == "trailer_standalone"
