from pathlib import Path

import pytest

from src.core.api.admin_routes import _hard_reset_targets, _safe_child


def test_hard_reset_targets_stay_inside_data_root(tmp_path: Path):
    directories, files = _hard_reset_targets(tmp_path)
    root = tmp_path.resolve()

    assert directories
    assert files
    assert all(root in path.parents for path in directories)
    assert all(path.parent == root for path in files)
    assert root / "projects" in directories
    assert root / "media" in directories
    assert root / "obsidian-vault" / "Projects" in directories


def test_safe_child_rejects_path_escape(tmp_path: Path):
    with pytest.raises(RuntimeError):
        _safe_child(tmp_path, "../outside")
