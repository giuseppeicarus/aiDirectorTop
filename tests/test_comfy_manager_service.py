import json
import sys
from pathlib import Path

from src.core.utils import comfy_manager_service as mgr


def reset_state(monkeypatch, tmp_path):
    state_path = tmp_path / "state.json"
    monkeypatch.setattr(mgr, "DATA_DIR", tmp_path)
    monkeypatch.setattr(mgr, "STATE_PATH", state_path)
    return state_path


def test_extract_node_types_from_node_class_mappings(tmp_path):
    pkg = tmp_path / "ComfyUI-Test"
    pkg.mkdir()
    (pkg / "nodes.py").write_text(
        'NODE_CLASS_MAPPINGS = {"Test_Load": Load, "Test_Save": Save}\n',
        encoding="utf-8",
    )

    found = mgr.extract_node_types(pkg)

    assert {item["class_type"] for item in found} == {"Test_Load", "Test_Save"}


def test_scan_node_detects_installed_and_unknown(monkeypatch, tmp_path):
    reset_state(monkeypatch, tmp_path)
    comfy_root = tmp_path / "ComfyRoot"
    custom_root = comfy_root / "custom_nodes"
    known = custom_root / "ComfyUI-VideoHelperSuite"
    unknown = custom_root / "MyCustomNode"
    known.mkdir(parents=True)
    unknown.mkdir()
    (known / "nodes.py").write_text('NODE_CLASS_MAPPINGS = {"VHS_LoadVideo": LoadVideo}\n', encoding="utf-8")
    (unknown / "nodes.py").write_text('NODE_CLASS_MAPPINGS = {"ExperimentalNodeXYZ": Node}\n', encoding="utf-8")

    monkeypatch.setattr(mgr, "get_node_ref", lambda node_id: {"id": str(node_id), "comfy_root_path": str(comfy_root)})

    result = mgr.scan_node("0", comfy_root_path=str(comfy_root), python_path=sys.executable)

    assert result["ok"] is True
    assert any(item["folder_name"] == "ComfyUI-VideoHelperSuite" for item in result["installed"])
    assert any(item["folder_name"] == "MyCustomNode" for item in result["unknown"])
    assert any(item["class_type"] == "VHS_LoadVideo" for item in result["node_types"])


def test_analyze_workflow_classifies_core_missing_and_unknown(monkeypatch, tmp_path):
    reset_state(monkeypatch, tmp_path)
    state = mgr.load_state()
    mgr.save_state(state)
    workflow = {
        "1": {"class_type": "KSampler", "inputs": {}},
        "2": {"class_type": "VHS_LoadVideo", "inputs": {}},
        "3": {"class_type": "ExperimentalNodeXYZ", "inputs": {}},
    }

    result = mgr.analyze_workflow(workflow, "demo.json")

    assert "KSampler" in result["ok"]
    assert any(item["class_type"] == "VHS_LoadVideo" for item in result["missing_custom_nodes"])
    assert "ExperimentalNodeXYZ" in result["unknown_node_types"]
    assert result["compatibility_score"] == 33


def test_install_package_does_not_clone_existing_custom_node(monkeypatch, tmp_path):
    reset_state(monkeypatch, tmp_path)
    comfy_root = tmp_path / "ComfyRoot"
    custom_root = comfy_root / "custom_nodes"
    existing = custom_root / "ComfyUI-VideoHelperSuite"
    existing.mkdir(parents=True)
    (existing / "nodes.py").write_text('NODE_CLASS_MAPPINGS = {"VHS_LoadVideo": LoadVideo}\n', encoding="utf-8")
    calls = []

    def fake_run_cmd(args, cwd=None, timeout=20.0):
        calls.append(args)
        return {"ok": True, "stdout": "", "stderr": "", "returncode": 0}

    monkeypatch.setattr(mgr, "run_cmd", fake_run_cmd)
    monkeypatch.setattr(mgr, "get_node_ref", lambda node_id: {"id": str(node_id), "comfy_root_path": str(comfy_root)})
    monkeypatch.setattr(mgr, "_node_paths", lambda node_id: {
        "comfy_root_path": str(comfy_root),
        "custom_nodes_path": str(custom_root),
        "python_path": sys.executable,
    })

    result = mgr.install_package("0", "comfyui-videohelpersuite")

    assert result["ok"] is True
    assert ["git", "clone", "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite", str(existing)] not in calls
