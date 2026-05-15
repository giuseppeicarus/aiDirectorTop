# ComfyUI API Reference

## Base URL
`http://{host}:{port}` (default port: 8188)

## Endpoints

### Queue a Workflow
```
POST /prompt
Content-Type: application/json

{
  "prompt": { ...workflow_dict... },
  "client_id": "uuid-v4"
}

Response: {"prompt_id": "uuid"}
```

### Get Execution History
```
GET /history/{prompt_id}

Response:
{
  "{prompt_id}": {
    "prompt": [...],
    "outputs": {
      "{node_id}": {
        "images": [{"filename": "xxx.png", "subfolder": "", "type": "output"}]
      }
    },
    "status": {"status_str": "success", "completed": true}
  }
}
```

### System Stats (health check)
```
GET /system_stats

Response:
{
  "system": {"os": "...", "ram_total": ...},
  "devices": [{"name": "NVIDIA RTX 4090", "vram_total": 24576, "vram_free": 20000}]
}
```

### Queue Status
```
GET /queue

Response:
{
  "queue_running": [...],
  "queue_pending": [...]
}
```

### Upload Image
```
POST /upload/image
Content-Type: multipart/form-data

file: <image_bytes>
type: input  (or: output, temp)
overwrite: false

Response: {"name": "uploaded_image.png", "subfolder": "", "type": "input"}
```

### Download File
```
GET /view?filename={name}&subfolder={subfolder}&type={type}

Returns: raw image/video bytes
```

### Available Node Types
```
GET /object_info

Response: { "{NodeClassName}": { "input": {...}, "output": [...] } }
```

### Cancel Execution
```
POST /interrupt

Response: {}
```

## WebSocket Real-time Updates
```
WS /ws?clientId={client_id}

Message types:
  {"type": "status", "data": {"status": {"exec_info": {"queue_remaining": N}}}}
  {"type": "progress", "data": {"value": N, "max": M, "prompt_id": "..."}}
  {"type": "executing", "data": {"node": "NodeName", "prompt_id": "..."}}
  {"type": "executed", "data": {"node": "SaveImage", "prompt_id": "...", "output": {...}}}
  {"type": "execution_error", "data": {"exception_message": "...", "prompt_id": "..."}}
  {"type": "execution_interrupted", "data": {"prompt_id": "..."}}
```

## Workflow Node Reference

### LoadImage
```json
{
  "class_type": "LoadImage",
  "inputs": {
    "image": "filename.png",  // must be uploaded first
    "upload": "image"
  }
}
```

### CheckpointLoaderSimple
```json
{
  "class_type": "CheckpointLoaderSimple",
  "inputs": {"ckpt_name": "model.safetensors"}
}
// Outputs: [MODEL, CLIP, VAE]
```

### CLIPTextEncode
```json
{
  "class_type": "CLIPTextEncode",
  "inputs": {"text": "prompt here", "clip": ["node_id", 1]}
}
// Outputs: [CONDITIONING]
```

### KSampler
```json
{
  "class_type": "KSampler",
  "inputs": {
    "model": ["checkpoint_node", 0],
    "positive": ["positive_clip_node", 0],
    "negative": ["negative_clip_node", 0],
    "latent_image": ["empty_latent_node", 0],
    "seed": 42,
    "steps": 30,
    "cfg": 7.0,
    "sampler_name": "dpm_2_ancestral",
    "scheduler": "karras",
    "denoise": 1.0
  }
}
// Outputs: [LATENT]
```

### VAEDecode
```json
{
  "class_type": "VAEDecode",
  "inputs": {"samples": ["ksampler_node", 0], "vae": ["checkpoint_node", 2]}
}
// Outputs: [IMAGE]
```

### SaveImage
```json
{
  "class_type": "SaveImage",
  "inputs": {"images": ["vae_decode_node", 0], "filename_prefix": "output_prefix"}
}
```

### EmptyLatentImage
```json
{
  "class_type": "EmptyLatentImage",
  "inputs": {"width": 1024, "height": 576, "batch_size": 1}
}
// Outputs: [LATENT]
```
