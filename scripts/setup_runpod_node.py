"""Create and test RunPod ComfyUI node."""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.core.api.comfyui_routes import _current_nodes_raw, _save_nodes, _probe_node
from src.core.config import ComfyUINodeConfig

NODE = {
    "name": "RunPod Remote",
    "host": "62.107.25.198",
    "port": 58539,
    "enabled": True,
    "auth_type": "token",
    "token": "1a4ab3463f706f58bedfa94bf2fb3e3ea7a6efa0e53fa01f5e15ee762ba8bcaa",
    "auth": None,
}


async def main() -> int:
    cfg = ComfyUINodeConfig(**NODE)
    print("=== Probe ===")
    result = await _probe_node(cfg)
    print(json.dumps(result, indent=2))

    if not result.get("online"):
        return 1

    print("\n=== Save config ===")
    nodes = _current_nodes_raw()
    # replace existing same host or append
    replaced = False
    for i, n in enumerate(nodes):
        if n.get("host") == NODE["host"] and n.get("port") == NODE["port"]:
            nodes[i] = NODE
            replaced = True
            print(f"Updated node index {i}")
            break
    if not replaced:
        nodes.append(NODE)
        print(f"Added node index {len(nodes) - 1}")
    _save_nodes(nodes)
    print("Saved to ~/.cinematic-studio/config.yaml")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
