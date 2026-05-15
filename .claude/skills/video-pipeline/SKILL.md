---
name: video-pipeline
description: Run, debug, and monitor the full video generation pipeline. Apply when executing pipeline stages, checking pipeline state, resuming interrupted pipelines, or debugging video generation issues.
---

# Video Pipeline Skill

## Pipeline Execution Checklist
Before running any pipeline stage:
1. Check `pipeline_state.json` — resume from last checkpoint if exists
2. Verify ComfyUI nodes are reachable (`GET /system_stats`)
3. Verify LLM is configured and reachable (for storyboard stage)
4. Check disk space (>5GB free recommended for video generation)

## Stage Commands (for development/debugging)
```bash
# Run full pipeline
python -m src.core.workflow.pipeline run --project-id {id}

# Run single stage
python -m src.core.workflow.pipeline run --project-id {id} --stage storyboard
python -m src.core.workflow.pipeline run --project-id {id} --stage frame_gen
python -m src.core.workflow.pipeline run --project-id {id} --stage video_gen
python -m src.core.workflow.pipeline run --project-id {id} --stage assembly

# Check pipeline state
python -m src.core.workflow.pipeline status --project-id {id}

# Reset pipeline state (will re-run all stages)
python -m src.core.workflow.pipeline reset --project-id {id}
```

## Common Errors & Solutions

| Error | Cause | Fix |
|-------|-------|-----|
| `ComfyUI timeout after 300s` | GPU overloaded or wrong workflow | Check ComfyUI queue, increase timeout |
| `JSON parse error in storyboard` | LLM returned non-JSON | Check LLM response log, retry |
| `No output files in history` | Wrong node ID in workflow | Verify SaveImage node name |
| `FFmpeg not found` | Not in PATH | Set `ffmpeg_path` in config |
| `CUDA out of memory` | Video resolution too high | Reduce resolution in workflow |

## Progress Weights (for total_progress calculation)
```python
STAGE_WEIGHTS = {
    "storyboard": 0.10,   # 10% of total
    "frame_gen":  0.35,   # 35% of total
    "video_gen":  0.45,   # 45% of total
    "assembly":   0.10,   # 10% of total
}
```
