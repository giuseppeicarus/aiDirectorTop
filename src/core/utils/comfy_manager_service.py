"""ComfyUI node/custom-node discovery and workflow compatibility services."""

from __future__ import annotations

import ast
import json
import os
import platform
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

from src.core.config import get_config


DATA_DIR = Path("~/.cinematic-studio").expanduser()
STATE_PATH = DATA_DIR / "custom_node_manager.json"
WORKFLOW_DIR = Path(__file__).parents[3] / "config" / "workflows"

CORE_NODE_TYPES = {
    "CLIPTextEncode",
    "CheckpointLoaderSimple",
    "ConditioningZeroOut",
    "EmptyLatentImage",
    "KSampler",
    "LoraLoader",
    "LoadImage",
    "ModelSamplingAuraFlow",
    "PreviewImage",
    "RandomNoise",
    "Reroute",
    "SaveImage",
    "MarkdownNote",
    "VAEDecode",
    "VAEEncode",
}

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

DEFAULT_PACKAGES: list[dict[str, Any]] = [
    {
        "id": "comfyui-manager",
        "name": "ComfyUI-Manager",
        "description": "ComfyUI extension manager and maintenance tools.",
        "github_url": "https://github.com/ltdrdata/ComfyUI-Manager",
        "branch": "main",
        "folder_name": "ComfyUI-Manager",
        "tags": ["utility"],
        "supported_os": ["windows", "linux", "macos"],
        "trusted": True,
        "enabled": True,
    },
    {
        "id": "comfyui-videohelpersuite",
        "name": "ComfyUI-VideoHelperSuite",
        "description": "Video loading, combining and frame utilities.",
        "github_url": "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite",
        "branch": "main",
        "folder_name": "ComfyUI-VideoHelperSuite",
        "tags": ["video", "utility"],
        "supported_os": ["windows", "linux", "macos"],
        "trusted": True,
        "enabled": True,
        "known_node_types": ["VHS_LoadVideo", "VHS_VideoCombine"],
    },
    {
        "id": "comfyui-kjnodes",
        "name": "ComfyUI-KJNodes",
        "description": "KJ utility nodes used by many video workflows.",
        "github_url": "https://github.com/kijai/ComfyUI-KJNodes",
        "branch": "main",
        "folder_name": "ComfyUI-KJNodes",
        "tags": ["video", "utility"],
        "supported_os": ["windows", "linux", "macos"],
        "trusted": True,
        "enabled": True,
        "known_node_types": ["KJNodes"],
    },
    {
        "id": "comfyui-ltxvideo",
        "name": "ComfyUI-LTXVideo",
        "description": "LTX Video nodes for image/video generation workflows.",
        "github_url": "https://github.com/Lightricks/ComfyUI-LTXVideo",
        "branch": "main",
        "folder_name": "ComfyUI-LTXVideo",
        "tags": ["video", "ltx"],
        "supported_os": ["windows", "linux", "macos"],
        "trusted": True,
        "enabled": True,
        "known_node_types": ["LTXVLoader", "LTXVModelLoader", "LTXVImgToVideo"],
    },
    {
        "id": "rgthree-comfy",
        "name": "rgthree-comfy",
        "description": "Workflow utility and routing nodes.",
        "github_url": "https://github.com/rgthree/rgthree-comfy",
        "branch": "main",
        "folder_name": "rgthree-comfy",
        "tags": ["utility"],
        "supported_os": ["windows", "linux", "macos"],
        "trusted": True,
        "enabled": True,
    },
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def package_id_from_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def load_state() -> dict[str, Any]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if STATE_PATH.exists():
        try:
            state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            state = {}
    else:
        state = {}
    state.setdefault("custom_node_packages", DEFAULT_PACKAGES)
    state.setdefault("node_custom_installations", [])
    state.setdefault("detected_custom_nodes", [])
    state.setdefault("custom_node_types", [])
    state.setdefault("node_paths", {})
    state.setdefault("provisioning_jobs", [])
    state.setdefault("provisioning_logs", [])
    return state


def save_state(state: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


def run_cmd(args: list[str], cwd: Optional[Path] = None, timeout: float = 20.0) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            args,
            cwd=str(cwd) if cwd else None,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        return {
            "ok": proc.returncode == 0,
            "stdout": proc.stdout.strip(),
            "stderr": proc.stderr.strip(),
            "returncode": proc.returncode,
        }
    except Exception as exc:
        return {"ok": False, "stdout": "", "stderr": str(exc), "returncode": -1}


def resolve_local_paths(comfy_root_path: Optional[str]) -> dict[str, Any]:
    root = Path(comfy_root_path).expanduser() if comfy_root_path else None
    if root and root.exists() and root.name.lower() == "comfyui" and (root.parent / "python_embeded").exists():
        portable_root = root.parent
    else:
        portable_root = root

    python_candidates: list[Path] = []
    custom_candidates: list[Path] = []
    if portable_root:
        python_candidates += [
            portable_root / "python_embeded" / "python.exe",
            portable_root / "ComfyUI" / "venv" / "Scripts" / "python.exe",
            portable_root / "venv" / "Scripts" / "python.exe",
            portable_root / "venv" / "bin" / "python",
        ]
        custom_candidates += [
            portable_root / "ComfyUI" / "custom_nodes",
            portable_root / "custom_nodes",
        ]
    python_path = next((p for p in python_candidates if p.exists()), None)
    custom_nodes_path = next((p for p in custom_candidates if p.exists()), None)
    return {
        "comfy_root_path": str(portable_root) if portable_root else None,
        "python_path": str(python_path) if python_path else None,
        "custom_nodes_path": str(custom_nodes_path) if custom_nodes_path else None,
        "python_candidates": [str(p) for p in python_candidates],
        "custom_nodes_candidates": [str(p) for p in custom_candidates],
    }


def get_node_ref(node_id: str) -> dict[str, Any]:
    cfg = get_config()
    idx = int(node_id) if str(node_id).isdigit() else -1
    if idx < 0 or idx >= len(cfg.comfyui.nodes):
        raise KeyError(f"Nodo {node_id} non trovato")
    node = cfg.comfyui.nodes[idx]
    state = load_state()
    extra = state.get("node_paths", {}).get(str(idx), {})
    comfy_root = extra.get("comfy_root_path") or node.ssh_comfyui_path
    return {
        "id": str(idx),
        "index": idx,
        "name": node.name,
        "host": node.host,
        "port": node.port,
        "type": "linux_remote_ssh" if node.provisioning_enabled and node.host not in {"localhost", "127.0.0.1", "::1"} else "windows_portable" if os.name == "nt" else f"{platform.system().lower()}_local",
        "provisioning_enabled": node.provisioning_enabled,
        "comfy_root_path": comfy_root,
        **extra,
    }


def list_comfy_nodes() -> list[dict[str, Any]]:
    cfg = get_config()
    state = load_state()
    out = []
    for idx, node in enumerate(cfg.comfyui.nodes):
        extra = state.get("node_paths", {}).get(str(idx), {})
        installs = [
            i for i in state["node_custom_installations"]
            if str(i.get("node_id")) == str(idx)
        ]
        issues = sum(1 for i in installs if i.get("status") in {"error", "missing", "unknown"} or i.get("dependencies_status") in {"missing", "incompatible"})
        out.append({
            "id": str(idx),
            "index": idx,
            "name": node.name,
            "host": node.host,
            "port": node.port,
            "type": "linux_remote_ssh" if node.provisioning_enabled and node.host not in {"localhost", "127.0.0.1", "::1"} else "windows_portable" if os.name == "nt" else f"{platform.system().lower()}_local",
            "status": extra.get("status", "unchecked"),
            "last_check": extra.get("last_check"),
            "latency": extra.get("latency"),
            "error_message": extra.get("error_message"),
            "gpu_info": extra.get("gpu_info"),
            "comfy_root_path": extra.get("comfy_root_path") or node.ssh_comfyui_path,
            "python_path": extra.get("python_path"),
            "custom_nodes_path": extra.get("custom_nodes_path"),
            "custom_nodes_count": len(installs),
            "issues_count": issues,
        })
    return out


def match_package(folder_name: str, git_url: str, catalog: Iterable[dict[str, Any]]) -> Optional[dict[str, Any]]:
    norm_folder = folder_name.lower()
    norm_url = (git_url or "").rstrip("/").lower()
    for pkg in catalog:
        if (pkg.get("folder_name") or "").lower() == norm_folder:
            return pkg
        if norm_url and (pkg.get("github_url") or "").rstrip("/").lower() == norm_url:
            return pkg
    return None


def parse_requirements(path: Path) -> list[str]:
    if not path.exists():
        return []
    names = []
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        name = re.split(r"[<>=!~;\[]", line, 1)[0].strip()
        if name:
            names.append(name.lower().replace("_", "-"))
    return names


def pip_freeze(python_path: Optional[str]) -> set[str]:
    if not python_path:
        return set()
    res = run_cmd([python_path, "-m", "pip", "freeze"], timeout=60)
    if not res["ok"]:
        return set()
    installed = set()
    for line in res["stdout"].splitlines():
        name = re.split(r"==| @ ", line, 1)[0].strip().lower().replace("_", "-")
        if name:
            installed.add(name)
    return installed


def extract_node_types(package_dir: Path) -> list[dict[str, str]]:
    found: list[dict[str, str]] = []
    for py_file in package_dir.rglob("*.py"):
        if any(part.startswith(".") or part == "__pycache__" for part in py_file.parts):
            continue
        text = py_file.read_text(encoding="utf-8", errors="ignore")
        for match in re.finditer(r"NODE_CLASS_MAPPINGS\s*=\s*\{(?P<body>.*?)\}", text, re.S):
            for key in re.finditer(r"[\"']([^\"']+)[\"']\s*:", match.group("body")):
                found.append({"class_type": key.group(1), "source_file": str(py_file)})
        if "NODE_CLASS_MAPPINGS" in text:
            try:
                tree = ast.parse(text)
                for node in ast.walk(tree):
                    if isinstance(node, ast.Assign):
                        if not any(isinstance(t, ast.Name) and t.id == "NODE_CLASS_MAPPINGS" for t in node.targets):
                            continue
                        if isinstance(node.value, ast.Dict):
                            for key in node.value.keys:
                                if isinstance(key, ast.Constant) and isinstance(key.value, str):
                                    item = {"class_type": key.value, "source_file": str(py_file)}
                                    if item not in found:
                                        found.append(item)
            except SyntaxError:
                pass
    return found


def scan_node(node_id: str, comfy_root_path: Optional[str] = None, custom_nodes_path: Optional[str] = None, python_path: Optional[str] = None) -> dict[str, Any]:
    state = load_state()
    node = get_node_ref(node_id)
    paths = resolve_local_paths(comfy_root_path or node.get("comfy_root_path"))
    if custom_nodes_path:
        paths["custom_nodes_path"] = str(Path(custom_nodes_path).expanduser())
    if python_path:
        paths["python_path"] = str(Path(python_path).expanduser())

    node_key = str(node_id)
    state["node_paths"].setdefault(node_key, {}).update(paths)
    state["node_paths"][node_key]["last_check"] = utc_now()

    custom_root = Path(paths["custom_nodes_path"]) if paths.get("custom_nodes_path") else None
    if not custom_root or not custom_root.exists():
        state["node_paths"][node_key].update({"status": "error", "error_message": "custom_nodes_path non trovato"})
        save_state(state)
        return {"ok": False, "node": state["node_paths"][node_key], "error": "custom_nodes_path non trovato"}

    installed_pkgs = pip_freeze(paths.get("python_path"))
    detected = []
    installs = [i for i in state["node_custom_installations"] if str(i.get("node_id")) != node_key]
    unknown = [d for d in state["detected_custom_nodes"] if str(d.get("node_id")) != node_key]
    node_types = [t for t in state["custom_node_types"] if str(t.get("node_id")) != node_key]

    for folder in sorted(p for p in custom_root.iterdir() if p.is_dir() and not p.name.startswith(".")):
        git_url = run_cmd(["git", "remote", "get-url", "origin"], cwd=folder).get("stdout", "")
        branch = run_cmd(["git", "branch", "--show-current"], cwd=folder).get("stdout", "")
        commit = run_cmd(["git", "rev-parse", "HEAD"], cwd=folder).get("stdout", "")
        pkg = match_package(folder.name, git_url, state["custom_node_packages"])
        reqs = parse_requirements(folder / "requirements.txt")
        missing = [r for r in reqs if installed_pkgs and r not in installed_pkgs]
        deps_status = "ok" if reqs and not missing else "missing" if missing else "unchecked"
        base = {
            "node_id": node_key,
            "folder_name": folder.name,
            "path": str(folder),
            "git_url": git_url,
            "branch": branch,
            "commit_hash": commit,
            "last_modified": datetime.fromtimestamp(folder.stat().st_mtime, timezone.utc).isoformat(),
            "requirements_present": (folder / "requirements.txt").exists(),
            "install_py_present": (folder / "install.py").exists(),
            "python_files": [str(p) for p in folder.glob("*.py")],
            "last_scan_at": utc_now(),
        }
        if pkg:
            installs.append({
                **base,
                "package_id": pkg["id"],
                "status": "installed",
                "dependencies_status": deps_status,
                "missing_dependencies": missing,
                "installed_at": base["last_scan_at"],
                "updated_at": base["last_scan_at"],
                "last_error": None,
            })
        else:
            unknown.append({**base, "status": "unknown", "detected_at": utc_now()})
        for item in extract_node_types(folder):
            node_types.append({
                "id": f"{node_key}:{folder.name}:{item['class_type']}",
                "node_id": node_key,
                "package_id": pkg["id"] if pkg else None,
                "folder_name": folder.name,
                "class_type": item["class_type"],
                "source_file": item["source_file"],
                "detected_automatically": True,
                "created_at": utc_now(),
                "updated_at": utc_now(),
            })
        detected.append({**base, "package_id": pkg["id"] if pkg else None, "status": "installed" if pkg else "unknown"})

    state["node_custom_installations"] = installs
    state["detected_custom_nodes"] = unknown
    state["custom_node_types"] = node_types
    state["node_paths"][node_key].update({"status": "online", "error_message": None})
    save_state(state)
    return {
        "ok": True,
        "node_id": node_key,
        "paths": state["node_paths"][node_key],
        "detected": detected,
        "installed": [i for i in installs if str(i.get("node_id")) == node_key],
        "unknown": [d for d in unknown if str(d.get("node_id")) == node_key],
        "node_types": [t for t in node_types if str(t.get("node_id")) == node_key],
    }


def add_unknown_to_registry(node_id: str, folder_name: str, payload: dict[str, Any]) -> dict[str, Any]:
    state = load_state()
    target = next((d for d in state["detected_custom_nodes"] if str(d.get("node_id")) == str(node_id) and d.get("folder_name") == folder_name), None)
    if not target:
        raise KeyError("Unknown custom node non trovato")
    pkg = {
        "id": payload.get("id") or package_id_from_name(payload.get("name") or folder_name),
        "name": payload.get("name") or folder_name,
        "description": payload.get("description") or "",
        "github_url": payload.get("github_url") or target.get("git_url") or "",
        "branch": payload.get("branch") or target.get("branch") or "main",
        "folder_name": payload.get("folder_name") or folder_name,
        "tags": payload.get("tags") or [],
        "supported_os": payload.get("supported_os") or ["windows", "linux", "macos"],
        "trusted": bool(payload.get("trusted", False)),
        "enabled": True,
    }
    state["custom_node_packages"] = [p for p in state["custom_node_packages"] if p.get("id") != pkg["id"]]
    state["custom_node_packages"].append(pkg)
    target["status"] = "added_to_registry"
    save_state(state)
    return pkg


def extract_workflow_node_types(workflow: dict[str, Any]) -> list[str]:
    types: set[str] = set()
    if isinstance(workflow.get("nodes"), list):
        for node in workflow["nodes"]:
            if isinstance(node, dict):
                value = node.get("type") or node.get("class_type")
                if value and not UUID_RE.match(str(value)):
                    types.add(str(value))
    for value in workflow.values():
        if isinstance(value, dict):
            class_type = value.get("class_type")
            if class_type and not UUID_RE.match(str(class_type)):
                types.add(str(class_type))
    return sorted(types)


def analyze_workflow(workflow: dict[str, Any], name: str = "workflow") -> dict[str, Any]:
    state = load_state()
    node_types = extract_workflow_node_types(workflow)
    known_types: dict[str, dict[str, Any]] = {}
    for row in state["custom_node_types"]:
        known_types[row["class_type"]] = row
    for pkg in state["custom_node_packages"]:
        for cls in pkg.get("known_node_types", []) or []:
            known_types.setdefault(cls, {"package_id": pkg["id"], "folder_name": pkg.get("folder_name")})

    ok, custom, missing, unknown = [], [], [], []
    installed_package_ids = {i.get("package_id") for i in state["node_custom_installations"] if i.get("status") == "installed"}
    for cls in node_types:
        if cls in CORE_NODE_TYPES:
            ok.append(cls)
            continue
        mapped = known_types.get(cls)
        if mapped:
            package_id = mapped.get("package_id")
            item = {"class_type": cls, "package_id": package_id, "folder_name": mapped.get("folder_name")}
            if package_id in installed_package_ids:
                custom.append(item)
            else:
                missing.append(item)
        else:
            unknown.append(cls)
    score = round((len(ok) + len(custom)) / max(len(node_types), 1) * 100)
    return {
        "workflow": name,
        "total_node_types": len(node_types),
        "compatibility_score": score,
        "ok": ok,
        "custom_node_ok": custom,
        "missing_custom_nodes": missing,
        "unknown_node_types": unknown,
        "missing_packages": sorted({m["package_id"] for m in missing if m.get("package_id")}),
        "missing_models": [],
        "missing_lora": [],
        "missing_dependencies": [
            i for i in state["node_custom_installations"]
            if i.get("dependencies_status") in {"missing", "incompatible"}
        ],
    }


def analyze_workflow_path(path_or_id: str) -> dict[str, Any]:
    path = Path(path_or_id)
    if not path.exists():
        path = WORKFLOW_DIR / path_or_id
    if not path.exists() and not path.suffix:
        path = WORKFLOW_DIR / f"{path_or_id}.json"
    workflow = json.loads(path.read_text(encoding="utf-8"))
    return analyze_workflow(workflow, path.name)


def _job(state: dict[str, Any], node_id: str, package_id: str, job_type: str) -> str:
    job_id = f"{job_type}-{node_id}-{package_id}-{int(time.time() * 1000)}"
    state["provisioning_jobs"].append({
        "id": job_id,
        "node_id": node_id,
        "package_id": package_id,
        "type": job_type,
        "status": "running",
        "started_at": utc_now(),
        "finished_at": None,
        "error_message": None,
    })
    return job_id


def _log(state: dict[str, Any], job_id: str, message: str, level: str = "info", node_id: Optional[str] = None) -> None:
    row = {"job_id": job_id, "level": level, "message": message, "created_at": utc_now()}
    if node_id is not None:
        row["node_id"] = node_id
    state["provisioning_logs"].append(row)


def _finish_job(state: dict[str, Any], job_id: str, status: str, error: Optional[str] = None) -> None:
    for job in state["provisioning_jobs"]:
        if job["id"] == job_id:
            job["status"] = status
            job["finished_at"] = utc_now()
            job["error_message"] = error
            break


def _package(state: dict[str, Any], package_id: str) -> dict[str, Any]:
    pkg = next((p for p in state["custom_node_packages"] if p.get("id") == package_id), None)
    if not pkg:
        raise KeyError(f"Package {package_id} non trovato")
    return pkg


def _node_paths(node_id: str) -> dict[str, Any]:
    state = load_state()
    node = get_node_ref(node_id)
    paths = state.get("node_paths", {}).get(str(node_id)) or resolve_local_paths(node.get("comfy_root_path"))
    if not paths.get("custom_nodes_path"):
        raise ValueError("custom_nodes_path non configurato: esegui prima Scan Node con path ComfyUI")
    return paths


def _install_requirements(python_path: Optional[str], req_path: Path, upgrade: bool = False) -> dict[str, Any]:
    if not req_path.exists():
        return {"ok": True, "skipped": True, "stdout": "", "stderr": ""}
    if not python_path:
        return {"ok": False, "stderr": "python_path non configurato", "stdout": ""}
    args = [python_path, "-m", "pip", "install", "-r", str(req_path)]
    if upgrade:
        args.append("--upgrade")
    return run_cmd(args, timeout=600)


def install_package(node_id: str, package_id: str, confirm_untrusted: bool = False) -> dict[str, Any]:
    state = load_state()
    pkg = _package(state, package_id)
    if not pkg.get("trusted") and not confirm_untrusted:
        raise PermissionError("Repository non trusted: conferma richiesta")
    paths = _node_paths(node_id)
    custom_root = Path(paths["custom_nodes_path"])
    target = custom_root / (pkg.get("folder_name") or pkg["name"])
    job_id = _job(state, str(node_id), package_id, "install")
    save_state(state)
    try:
        state = load_state()
        _log(state, job_id, "Checking existing installation", node_id=str(node_id))
        if target.exists():
            _log(state, job_id, "Existing custom node found; skipping git clone", node_id=str(node_id))
        else:
            url = pkg.get("github_url") or ""
            if not re.match(r"^https://github\.com/[^/]+/[^/]+/?$", url):
                raise ValueError("github_url non valido o non consentito")
            custom_root.mkdir(parents=True, exist_ok=True)
            res = run_cmd(["git", "clone", url, str(target)], timeout=900)
            if not res["ok"]:
                raise RuntimeError(res["stderr"] or res["stdout"] or "git clone failed")
            branch = pkg.get("branch")
            if branch:
                checkout = run_cmd(["git", "checkout", branch], cwd=target, timeout=120)
                if not checkout["ok"]:
                    raise RuntimeError(checkout["stderr"] or checkout["stdout"] or "git checkout failed")
        req_res = _install_requirements(paths.get("python_path"), target / (pkg.get("requirements_path") or "requirements.txt"))
        if not req_res["ok"]:
            raise RuntimeError(req_res["stderr"] or req_res["stdout"] or "pip install failed")
        install_py = target / (pkg.get("install_script") or "install.py")
        if install_py.exists() and paths.get("python_path"):
            script_res = run_cmd([paths["python_path"], str(install_py)], cwd=target, timeout=600)
            if not script_res["ok"]:
                raise RuntimeError(script_res["stderr"] or script_res["stdout"] or "install.py failed")
        save_state(state)
        result = scan_node(str(node_id), custom_nodes_path=paths["custom_nodes_path"], python_path=paths.get("python_path"))
        state = load_state()
        _finish_job(state, job_id, "success")
        _log(state, job_id, "SUCCESS", node_id=str(node_id))
        save_state(state)
        return {"ok": True, "job_id": job_id, "scan": result}
    except Exception as exc:
        _finish_job(state, job_id, "error", str(exc))
        _log(state, job_id, str(exc), "error", node_id=str(node_id))
        save_state(state)
        raise


def update_package(node_id: str, package_id: str) -> dict[str, Any]:
    state = load_state()
    pkg = _package(state, package_id)
    paths = _node_paths(node_id)
    target = Path(paths["custom_nodes_path"]) / (pkg.get("folder_name") or pkg["name"])
    job_id = _job(state, str(node_id), package_id, "update")
    save_state(state)
    try:
        state = load_state()
        if not target.exists():
            raise FileNotFoundError("Custom node non installato")
        backup = target.with_name(f"{target.name}.backup-{int(time.time())}")
        shutil.copytree(target, backup)
        _log(state, job_id, f"Backup created: {backup}", node_id=str(node_id))
        for args in (["git", "fetch"], ["git", "checkout", pkg.get("branch") or "main"], ["git", "pull", "--ff-only"]):
            res = run_cmd(args, cwd=target, timeout=300)
            if not res["ok"]:
                raise RuntimeError(res["stderr"] or res["stdout"] or "git update failed")
        req_res = _install_requirements(paths.get("python_path"), target / (pkg.get("requirements_path") or "requirements.txt"), upgrade=True)
        if not req_res["ok"]:
            raise RuntimeError(req_res["stderr"] or req_res["stdout"] or "pip install failed")
        save_state(state)
        result = scan_node(str(node_id), custom_nodes_path=paths["custom_nodes_path"], python_path=paths.get("python_path"))
        state = load_state()
        _finish_job(state, job_id, "success")
        _log(state, job_id, "SUCCESS", node_id=str(node_id))
        save_state(state)
        return {"ok": True, "job_id": job_id, "backup": str(backup), "scan": result}
    except Exception as exc:
        _finish_job(state, job_id, "error", str(exc))
        _log(state, job_id, str(exc), "error", node_id=str(node_id))
        save_state(state)
        raise


def remove_package(node_id: str, package_id: str, mode: str = "disable", confirm_delete: bool = False) -> dict[str, Any]:
    state = load_state()
    pkg = _package(state, package_id)
    paths = _node_paths(node_id)
    target = Path(paths["custom_nodes_path"]) / (pkg.get("folder_name") or pkg["name"])
    job_id = _job(state, str(node_id), package_id, "remove")
    save_state(state)
    try:
        state = load_state()
        if not target.exists():
            raise FileNotFoundError("Custom node non installato")
        if mode == "delete":
            if not confirm_delete:
                raise PermissionError("Delete richiede conferma esplicita")
            backup = target.with_name(f"{target.name}.deleted-backup-{int(time.time())}")
            shutil.move(str(target), str(backup))
            _log(state, job_id, f"Moved to backup: {backup}", node_id=str(node_id))
            result = {"backup": str(backup)}
        else:
            disabled = target.with_name(f"{target.name}.disabled")
            if disabled.exists():
                disabled = target.with_name(f"{target.name}.disabled-{int(time.time())}")
            shutil.move(str(target), str(disabled))
            result = {"disabled_path": str(disabled)}
        save_state(state)
        scan = scan_node(str(node_id), custom_nodes_path=paths["custom_nodes_path"], python_path=paths.get("python_path"))
        state = load_state()
        _finish_job(state, job_id, "success")
        _log(state, job_id, "SUCCESS", node_id=str(node_id))
        save_state(state)
        return {"ok": True, "job_id": job_id, **result, "scan": scan}
    except Exception as exc:
        _finish_job(state, job_id, "error", str(exc))
        _log(state, job_id, str(exc), "error", node_id=str(node_id))
        save_state(state)
        raise


def fix_dependencies(node_id: str, package_id: str) -> dict[str, Any]:
    state = load_state()
    pkg = _package(state, package_id)
    paths = _node_paths(node_id)
    target = Path(paths["custom_nodes_path"]) / (pkg.get("folder_name") or pkg["name"])
    job_id = _job(state, str(node_id), package_id, "fix_dependencies")
    save_state(state)
    try:
        state = load_state()
        req_res = _install_requirements(paths.get("python_path"), target / (pkg.get("requirements_path") or "requirements.txt"), upgrade=True)
        if not req_res["ok"]:
            raise RuntimeError(req_res["stderr"] or req_res["stdout"] or "pip install failed")
        save_state(state)
        result = scan_node(str(node_id), custom_nodes_path=paths["custom_nodes_path"], python_path=paths.get("python_path"))
        state = load_state()
        _finish_job(state, job_id, "success")
        _log(state, job_id, "SUCCESS", node_id=str(node_id))
        save_state(state)
        return {"ok": True, "job_id": job_id, "scan": result}
    except Exception as exc:
        _finish_job(state, job_id, "error", str(exc))
        _log(state, job_id, str(exc), "error", node_id=str(node_id))
        save_state(state)
        raise
