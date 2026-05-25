# ai-toolkit LoRA Runner

Create Personaggio can run `ostris/ai-toolkit` in three modes:

- `docker`: local isolated container, recommended for a workstation GPU.
- `remote`: custom HTTP endpoint on RunPod/Vast or another GPU host.
- `local`: direct `python run.py`, useful only for debugging.

Default config lives in `config/default.yaml` under `ai_toolkit`.

## Local Docker

Build the image:

```powershell
docker compose -f docker/ai-toolkit/docker-compose.yml build
```

The app runs jobs with:

```powershell
docker run --rm --gpus all `
  -v "$HOME/.cinematic-studio/ai-toolkit-training:/workspace/training" `
  -v "$HOME/.cache/huggingface:/root/.cache/huggingface" `
  cinematic-ai/ai-toolkit:local /workspace/training/<job>/config/<job>.yaml
```

For gated FLUX models, authenticate first:

```powershell
huggingface-cli login
```

or set `HUGGING_FACE_HUB_TOKEN` / `HF_TOKEN` in the environment used by Docker.

## Remote RunPod/Vast

Set:

```yaml
ai_toolkit:
  backend: "remote"
  remote_url: "https://YOUR-ENDPOINT/run-lora"
  remote_api_key: "optional-bearer-token"
```

The app sends a ZIP containing the generated ai-toolkit config and dataset. The
remote endpoint should accept multipart fields:

- `config`: JSON metadata
- `bundle`: ZIP file with `config/`, `dataset/`, and empty `output/`

Expected JSON response:

```json
{
  "ok": true,
  "status": "started",
  "job_id": "remote-job-id",
  "lora_path": null,
  "message": "queued"
}
```
