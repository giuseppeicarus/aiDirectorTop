---
name: comfyui-workflow-builder
description: Build and validate ComfyUI workflow JSON for txt2img frame generation and img2video clip generation. Apply this skill when creating or modifying workflow templates in config/workflows/.
---

# ComfyUI Workflow Builder Skill

When building a ComfyUI workflow JSON for CinematicAI Studio:

## Step 1: Identify Workflow Type
- `txt2img` → generate first/last frames from text prompt
- `img2video` → generate video clip from first+last frames
- `upscale` → upscale frame before video generation

## Step 2: Select Base Template
Read the existing template from `config/workflows/` that matches the type.
Never build from scratch — always extend a template.

## Step 3: Key Node IDs to Always Include

### txt2img (SDXL/Flux)
```json
{
  "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "{{MODEL}}"}},
  "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{POSITIVE_PROMPT}}", "clip": ["4", 1]}},
  "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{NEGATIVE_PROMPT}}", "clip": ["4", 1]}},
  "8": {"class_type": "VAEDecode", "inputs": {"samples": ["13", 0], "vae": ["4", 2]}},
  "13": {"class_type": "KSampler", "inputs": {
    "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0],
    "latent_image": ["5", 0], "seed": {{SEED}}, "steps": {{STEPS}},
    "cfg": {{CFG}}, "sampler_name": "dpm_2_ancestral", "scheduler": "karras",
    "denoise": 1.0
  }},
  "5": {"class_type": "EmptyLatentImage", "inputs": {"width": {{WIDTH}}, "height": {{HEIGHT}}, "batch_size": 1}},
  "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "{{OUTPUT_PREFIX}}"}}
}
```

### img2video (WAN 2.1)
Load image → WanVideoModel → KSampler → Decode → SaveVideo
Key nodes: `LoadImage`, `WanVideoModelLoader`, `WanVideoSampler`, `VideoDecoder`, `SaveVideo`

## Step 4: Variable Substitution Pattern
Templates use `{{VARIABLE}}` placeholders.
In Python, replace with: `json.dumps(workflow_template).replace("{{VARIABLE}}", value)`

## Step 5: Validation
Before submitting to ComfyUI:
1. Check all node input references exist (`["node_id", output_index]`)
2. Verify model names against `/object_info` or config
3. Ensure SaveImage/SaveVideo node has unique filename_prefix

## Step 6: Write Template
Save to `config/workflows/{type}_{model_family}.json`

## Token-saving note
When working on workflows, read ONLY the specific template file needed,
not the entire config directory.
