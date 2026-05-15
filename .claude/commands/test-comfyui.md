---
name: test-comfyui
description: Test connectivity and capabilities of a ComfyUI node. Usage: /test-comfyui http://localhost:8188
---

# Test ComfyUI Node: $ARGUMENTS

Run a complete connectivity and capability check for the specified ComfyUI node.

## Steps

1. **Health check** — GET `$ARGUMENTS/system_stats`
   - Report: GPU info, VRAM free, queue depth

2. **Available models** — GET `$ARGUMENTS/object_info`
   - List: checkpoint models, VAEs, LoRAs, video models
   - Check if required models are present (from config/default.yaml)

3. **Queue a test txt2img** — POST `$ARGUMENTS/prompt`
   - Use a minimal 512x512, 5-step workflow
   - Wait for completion (max 60s)
   - Report: success/fail, time taken

4. **Report summary**
   ```
   Node: $ARGUMENTS
   Status: ✅ Online / ❌ Offline
   GPU: [name]
   VRAM: [free]/[total] GB
   Queue: [pending] jobs
   Models: [n] checkpoints, [n] video models
   Test render: ✅ [X.Xs] / ❌ [error]
   ```

Write test results to `~/.cinematic-studio/node_test_results.json`
