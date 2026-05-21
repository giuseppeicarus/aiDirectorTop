"""
LTX Director 2.3 Workflow Builder — WhatDreamsCost plugin integration.

Builds ComfyUI workflow dicts programmatically for the LTX Director system.
Two entry points:
  - build_ltx_director_shot_workflow   — per-shot mode (one clip at a time)
  - build_ltx_director_full_video_workflow — full-video timeline mode

Node IDs are stable integers in the 1000-3999 range so they never collide
with existing manifest-based workflow nodes.

Dependencies: standard library + project models only (no circular imports).
"""

from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field
from typing import Optional

from src.core.models.cinematic import (
    AudioAnalysis,
    CinematicShot,
    StoryArc,
)


# ── Configuration dataclass ────────────────────────────────────────────────────

@dataclass
class LTXDirectorConfig:
    """Model names and sampling parameters for LTX Director 2.3."""

    # Model file names (must match what is installed in ComfyUI)
    checkpoint: str = "ltx-video-2b-v0.9.6.safetensors"
    clip_name1: str = "t5xxl_fp16.safetensors"
    clip_name2: str = ""
    video_vae: str = "ltx-video-vae-decode-v0.9.6.safetensors"
    audio_vae: str = "ltx-video-2b-v0.9.6.safetensors"
    upscale_model: str = "ltxv_spatial_upscaler_0.9.7.safetensors"
    lora_name: str = ""            # empty string = no LoRA
    lora_strength: float = 1.0

    # Sampling
    stage1_steps: int = 8
    stage2_steps: int = 4
    cfg_scale: float = 1.0
    sampler: str = "euler"
    scheduler: str = "linear"
    denoise_stage1: float = 1.0
    denoise_stage2: float = 0.4

    # Frame rate
    frame_rate: int = 24

    # Optional tiny VAE for previews (empty = not used)
    preview_vae: str = ""


# ── Node-ID constants ──────────────────────────────────────────────────────────

# Loaders
_N_CKPT      = "1001"
_N_CLIP      = "1002"
_N_VAE_VID   = "1003"
_N_VAE_AUD   = "1004"
_N_LORA      = "1005"   # optional

# LTX Director core
_N_DIRECTOR  = "1010"
_N_LTXVCOND  = "1011"
_N_ZERO_NEG  = "1012"

# Stage 1 — guide + sampling
_N_GUIDE1    = "1020"
_N_CFG1      = "1021"
_N_NOISE1    = "1022"
_N_SAMPLER1  = "1023"
_N_SCHED1    = "1024"
_N_CUSTOM1   = "1025"
_N_SEPAV1    = "1026"

# Stage 2 — upsampling + re-sampling
_N_CROPGUIDE = "1030"
_N_UPMODEL   = "1031"
_N_UPSAMPLE  = "1032"
_N_GUIDE2    = "1033"
_N_CFG2      = "1034"
_N_SAMPLER2  = "1035"
_N_SCHED2    = "1036"
_N_CUSTOM2   = "1037"
_N_SEPAV2    = "1038"

# Output
_N_CONCAT_AV = "1040"
_N_VAE_DEC   = "1041"
_N_AUD_DEC   = "1042"
_N_SAVE_VID  = "1043"

# Image loaders start at 2001 (incremented per guide frame)
_IMG_BASE    = 2001

# Audio loader
_N_AUDIO     = "3001"


# ── Internal helpers ───────────────────────────────────────────────────────────

def _ref(node_id: str | int, output_idx: int = 0) -> list:
    """Return a ComfyUI node-reference: [node_id_str, output_index]."""
    return [str(node_id), output_idx]


def _loader_nodes(cfg: LTXDirectorConfig) -> dict:
    """
    Build the model-loader sub-graph.

    Returns nodes dict fragment. If cfg.lora_name is set the model output
    is taken from the LoRA loader (node _N_LORA), otherwise from checkpoint.
    """
    nodes: dict = {
        _N_CKPT: {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": cfg.checkpoint},
            "_meta": {"title": "LTX 2.3 Checkpoint"},
        },
        _N_CLIP: {
            "class_type": "DualCLIPLoader",
            "inputs": {
                "clip_name1": cfg.clip_name1,
                "clip_name2": cfg.clip_name2,
                "type": "ltxv",
                "device": "default",
            },
            "_meta": {"title": "Dual CLIP Loader"},
        },
        _N_VAE_VID: {
            "class_type": "VAELoaderKJ",
            "inputs": {"vae_name": cfg.video_vae},
            "_meta": {"title": "Video VAE Loader"},
        },
        _N_VAE_AUD: {
            "class_type": "VAELoaderKJ",
            "inputs": {"vae_name": cfg.audio_vae},
            "_meta": {"title": "Audio VAE Loader"},
        },
    }
    if cfg.lora_name:
        nodes[_N_LORA] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "lora_name": cfg.lora_name,
                "strength_model": cfg.lora_strength,
                "model": _ref(_N_CKPT, 0),
            },
            "_meta": {"title": "LoRA Loader"},
        }
    return nodes


def _model_ref(cfg: LTXDirectorConfig) -> list:
    """Return reference to the final model output (after optional LoRA)."""
    if cfg.lora_name:
        return _ref(_N_LORA, 0)
    return _ref(_N_CKPT, 0)


def _audio_nodes(audio_comfyui_name: str, audio_start_sec: float) -> dict:
    """Build LoadAudio node."""
    return {
        _N_AUDIO: {
            "class_type": "LoadAudio",
            "inputs": {
                "audio": audio_comfyui_name,
                "start_seconds": audio_start_sec,
            },
            "_meta": {"title": "Load Audio"},
        }
    }


def _image_loader_node(node_id: str | int, filename: str) -> dict:
    """Single LoadImage node dict."""
    return {
        str(node_id): {
            "class_type": "LoadImage",
            "inputs": {
                "image": filename,
                "upload": "image",
            },
            "_meta": {"title": f"Guide Frame {node_id}"},
        }
    }


def _build_timeline_data(
    segment_prompts: list[str],
    segment_frame_counts: list[int],
    guide_frames: list[dict],
) -> str:
    """
    Build the timeline_data JSON string consumed by LTXDirector.

    guide_frames: list of {"frame": int, "imagePath": str, "strength": float}
    segment_prompts and segment_frame_counts must have the same length.

    Returns a compact JSON string (empty string if no data is provided).
    """
    if not segment_prompts and not guide_frames:
        return ""

    segments: list[dict] = []
    cursor = 0
    for i, (prompt, count) in enumerate(zip(segment_prompts, segment_frame_counts)):
        seg_start = cursor
        seg_end   = cursor + count - 1
        # Find guide frames that fall within this segment
        seg_guides = [
            {
                "frame":     gf["frame"],
                "imagePath": gf["imagePath"],
                "strength":  gf.get("strength", 1.0),
                "type":      gf.get("type", "image"),
            }
            for gf in guide_frames
            if seg_start <= gf["frame"] <= seg_end
        ]
        segments.append({
            "start":  seg_start,
            "end":    seg_end,
            "prompt": prompt,
            "guides": seg_guides,
        })
        cursor += count

    return json.dumps({"segments": segments}, separators=(",", ":"))


def _core_nodes(
    cfg: LTXDirectorConfig,
    global_prompt: str,
    local_prompts_str: str,
    segment_lengths_str: str,
    total_frames: int,
    total_seconds: float,
    width: int,
    height: int,
    use_audio: bool,
    timeline_data: str,
) -> dict:
    """
    Build LTXDirector + LTXVConditioning + ConditioningZeroOut nodes.
    Returns nodes dict fragment.
    """
    director_inputs: dict = {
        "model":           _model_ref(cfg),
        "clip":            _ref(_N_CLIP, 0),
        "global_prompt":   global_prompt,
        "local_prompts":   local_prompts_str,
        "segment_lengths": segment_lengths_str,
        "timeline_data":   timeline_data,
        "duration_frames": total_frames,
        "duration_seconds": total_seconds,
        "frame_rate":      float(cfg.frame_rate),
        "custom_width":    width,
        "custom_height":   height,
        "use_custom_audio": use_audio,
        "epsilon":         0.001,
        "guide_strength":  "",
    }
    if use_audio:
        director_inputs["audio_vae"] = _ref(_N_VAE_AUD, 0)
        director_inputs["audio"]     = _ref(_N_AUDIO, 0)

    return {
        _N_DIRECTOR: {
            "class_type": "LTXDirector",
            "inputs": director_inputs,
            "_meta": {"title": "LTX Director"},
        },
        _N_ZERO_NEG: {
            "class_type": "ConditioningZeroOut",
            "inputs": {"conditioning": _ref(_N_DIRECTOR, 1)},
            "_meta": {"title": "Zero Negative Conditioning"},
        },
        _N_LTXVCOND: {
            "class_type": "LTXVConditioning",
            "inputs": {
                "positive":     _ref(_N_DIRECTOR, 1),
                "negative":     _ref(_N_ZERO_NEG, 0),
                "frame_rate":   _ref(_N_DIRECTOR, 5),
                "image_height": height,
                "image_width":  width,
                "latent":       _ref(_N_DIRECTOR, 2),
            },
            "_meta": {"title": "LTXV Conditioning"},
        },
    }


def _stage1_nodes(cfg: LTXDirectorConfig) -> dict:
    """Stage-1 sampling: LTXDirectorGuide → CFGGuider → SamplerCustomAdvanced → LTXVSeparateAVLatent."""
    return {
        _N_GUIDE1: {
            "class_type": "LTXDirectorGuide",
            "inputs": {
                "positive":        _ref(_N_LTXVCOND, 0),
                "negative":        _ref(_N_LTXVCOND, 1),
                "vae":             _ref(_N_VAE_VID, 0),
                "latent":          _ref(_N_DIRECTOR, 2),
                "guide_data":      _ref(_N_DIRECTOR, 4),
                "scale_by":        1.0,
                "upscale_method":  "nearest-exact",
            },
            "_meta": {"title": "LTX Director Guide (Stage 1)"},
        },
        _N_CFG1: {
            "class_type": "CFGGuider",
            "inputs": {
                "cfg":      cfg.cfg_scale,
                "model":    _ref(_N_GUIDE1, 0),
                "positive": _ref(_N_GUIDE1, 1),
                "negative": _ref(_N_GUIDE1, 2),
            },
            "_meta": {"title": "CFG Guider (Stage 1)"},
        },
        _N_NOISE1: {
            "class_type": "RandomNoise",
            "inputs": {"noise_seed": random.randint(0, 2 ** 32)},
            "_meta": {"title": "Random Noise (Stage 1)"},
        },
        _N_SAMPLER1: {
            "class_type": "KSamplerSelect",
            "inputs": {"sampler_name": cfg.sampler},
            "_meta": {"title": "KSampler Select (Stage 1)"},
        },
        _N_SCHED1: {
            "class_type": "BasicScheduler",
            "inputs": {
                "scheduler": cfg.scheduler,
                "steps":     cfg.stage1_steps,
                "denoise":   cfg.denoise_stage1,
                "model":     _ref(_N_GUIDE1, 0),
            },
            "_meta": {"title": "Basic Scheduler (Stage 1)"},
        },
        _N_CUSTOM1: {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise":        _ref(_N_NOISE1, 0),
                "guider":       _ref(_N_CFG1, 0),
                "sampler":      _ref(_N_SAMPLER1, 0),
                "sigmas":       _ref(_N_SCHED1, 0),
                "latent_image": _ref(_N_GUIDE1, 3),
            },
            "_meta": {"title": "Sampler Custom Advanced (Stage 1)"},
        },
        _N_SEPAV1: {
            "class_type": "LTXVSeparateAVLatent",
            "inputs": {"av_latent": _ref(_N_CUSTOM1, 0)},
            "_meta": {"title": "Separate AV Latent (Stage 1)"},
        },
    }


def _stage2_nodes(cfg: LTXDirectorConfig) -> dict:
    """Stage-2: upscale → LTXDirectorGuide → CFGGuider → sample → LTXVSeparateAVLatent."""
    return {
        _N_CROPGUIDE: {
            "class_type": "LTXVCropGuides",
            "inputs": {
                "positive": _ref(_N_LTXVCOND, 0),
                "negative": _ref(_N_LTXVCOND, 1),
                "latent":   _ref(_N_SEPAV1, 0),
            },
            "_meta": {"title": "LTXV Crop Guides"},
        },
        _N_UPMODEL: {
            "class_type": "LatentUpscaleModelLoader",
            "inputs": {"model_name": cfg.upscale_model},
            "_meta": {"title": "Upscale Model Loader"},
        },
        _N_UPSAMPLE: {
            "class_type": "LTXVLatentUpsampler",
            "inputs": {
                "samples":       _ref(_N_SEPAV1, 0),
                "upscale_model": _ref(_N_UPMODEL, 0),
                "vae":           _ref(_N_VAE_VID, 0),
            },
            "_meta": {"title": "LTXV Latent Upsampler"},
        },
        _N_GUIDE2: {
            "class_type": "LTXDirectorGuide",
            "inputs": {
                "positive":       _ref(_N_CROPGUIDE, 0),
                "negative":       _ref(_N_CROPGUIDE, 1),
                "vae":            _ref(_N_VAE_VID, 0),
                "latent":         _ref(_N_UPSAMPLE, 0),
                "guide_data":     _ref(_N_DIRECTOR, 4),
                "scale_by":       1.0,
                "upscale_method": "nearest-exact",
            },
            "_meta": {"title": "LTX Director Guide (Stage 2)"},
        },
        _N_CFG2: {
            "class_type": "CFGGuider",
            "inputs": {
                "cfg":      cfg.cfg_scale,
                "model":    _ref(_N_GUIDE2, 0),
                "positive": _ref(_N_GUIDE2, 1),
                "negative": _ref(_N_GUIDE2, 2),
            },
            "_meta": {"title": "CFG Guider (Stage 2)"},
        },
        _N_SAMPLER2: {
            "class_type": "KSamplerSelect",
            "inputs": {"sampler_name": cfg.sampler},
            "_meta": {"title": "KSampler Select (Stage 2)"},
        },
        _N_SCHED2: {
            "class_type": "BasicScheduler",
            "inputs": {
                "scheduler": cfg.scheduler,
                "steps":     cfg.stage2_steps,
                "denoise":   cfg.denoise_stage2,
                "model":     _ref(_N_GUIDE2, 0),
            },
            "_meta": {"title": "Basic Scheduler (Stage 2)"},
        },
        _N_CUSTOM2: {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise":        _ref(_N_NOISE1, 0),   # reuse same noise tensor
                "guider":       _ref(_N_CFG2, 0),
                "sampler":      _ref(_N_SAMPLER2, 0),
                "sigmas":       _ref(_N_SCHED2, 0),
                "latent_image": _ref(_N_GUIDE2, 3),
            },
            "_meta": {"title": "Sampler Custom Advanced (Stage 2)"},
        },
        _N_SEPAV2: {
            "class_type": "LTXVSeparateAVLatent",
            "inputs": {"av_latent": _ref(_N_CUSTOM2, 0)},
            "_meta": {"title": "Separate AV Latent (Stage 2)"},
        },
    }


def _output_nodes(
    output_prefix: str,
    use_audio: bool,
) -> dict:
    """
    Build decode + save nodes.

    Video latent → VAEDecode → SaveVideo.
    Audio latent (stage-1 audio) → LTXVAudioVAEDecode → merged into SaveVideo.
    When use_audio is False the audio path is skipped and a silent video is saved.
    """
    # Concatenate stage-2 video with stage-1 audio
    concat_inputs: dict = {
        "video_latent": _ref(_N_SEPAV2, 0),
        "audio_latent": _ref(_N_SEPAV1, 1),  # index 1 = audio portion from stage-1
    }
    nodes: dict = {
        _N_CONCAT_AV: {
            "class_type": "LTXVConcatAVLatent",
            "inputs": concat_inputs,
            "_meta": {"title": "Concat AV Latent"},
        },
        _N_VAE_DEC: {
            "class_type": "VAEDecode",
            "inputs": {
                "samples": _ref(_N_CONCAT_AV, 0),
                "vae":     _ref(_N_VAE_VID, 0),
            },
            "_meta": {"title": "VAE Decode"},
        },
        _N_SAVE_VID: {
            "class_type": "SaveVideo",
            "inputs": {
                "filename_prefix": output_prefix,
                "format":          "auto",
                "codec":           "auto",
                "video":           _ref(_N_VAE_DEC, 0),
            },
            "_meta": {"title": "Save Video"},
        },
    }
    if use_audio:
        nodes[_N_AUD_DEC] = {
            "class_type": "LTXVAudioVAEDecode",
            "inputs": {
                "samples":   _ref(_N_CONCAT_AV, 1),
                "audio_vae": _ref(_N_VAE_AUD, 0),
            },
            "_meta": {"title": "Audio VAE Decode"},
        }
        # Attach decoded audio to SaveVideo
        nodes[_N_SAVE_VID]["inputs"]["audio"] = _ref(_N_AUD_DEC, 0)
    return nodes


def _compose_global_prompt(shot: CinematicShot) -> str:
    """Use LLM-generated ltx_global_prompt if available, else assemble from cinematic fields."""
    if shot.ltx_global_prompt:
        return shot.ltx_global_prompt
    # Fallback: assemble from metadata
    parts: list[str] = []
    if shot.scene_description:
        parts.append(shot.scene_description)
    if shot.emotion:
        parts.append(f"Emotional tone: {shot.emotion}")
    if shot.location:
        parts.append(f"Location: {shot.location}")
    if shot.lighting:
        lighting_parts = [shot.lighting.time_of_day, shot.lighting.mood]
        if shot.lighting.sources:
            lighting_parts.append(", ".join(shot.lighting.sources))
        parts.append(f"Lighting: {' '.join(p for p in lighting_parts if p)}")
    if shot.camera:
        cam_parts = [
            f"{shot.camera.shot_type} shot",
            f"{shot.camera.movement} movement",
            f"{shot.camera.lens_mm}mm lens",
            f"{shot.camera.depth_of_field} depth of field",
        ]
        if shot.camera.special:
            cam_parts.append(shot.camera.special)
        parts.append("Camera: " + ", ".join(cam_parts))
    return ". ".join(parts)


def _compose_global_prompt_full(
    shots: list[CinematicShot],
    story_arc: StoryArc | None,
) -> str:
    """Build the global_prompt for the full-video workflow."""
    parts: list[str] = []
    if story_arc:
        if story_arc.logline:
            parts.append(story_arc.logline)
        if story_arc.visual_motifs:
            parts.append("Visual motifs: " + ", ".join(story_arc.visual_motifs[:6]))
        if story_arc.color_palette:
            parts.append("Color palette: " + ", ".join(story_arc.color_palette[:6]))
    # Style summary from first shot (usually carries style references)
    if shots:
        s0 = shots[0]
        if s0.lighting:
            parts.append(f"Overall lighting: {s0.lighting.mood}")
    parts.append(
        "Cinematic, photorealistic, professional cinematography, "
        "film grain, dramatic lighting, high production value."
    )
    return " ".join(parts)


def _build_shot_local_prompts(shot: CinematicShot) -> tuple[list[str], list[int]]:
    """
    Split a single shot into two segments: intro phase and motion phase.

    Returns (prompts_list, frame_counts_list).
    """
    fps         = 24
    total_f     = max(1, round(shot.duration_sec * fps))
    half_f      = max(1, total_f // 2)
    motion_f    = total_f - half_f

    # Build rich intro prompt from scene + characters + emotion
    intro_parts = []
    if shot.lyrics_segment:
        intro_parts.append(f'"{shot.lyrics_segment}"')
    if shot.scene_description:
        intro_parts.append(shot.scene_description)
    if shot.characters:
        char_descs = [
            f"{c.get('name','')}: {c.get('action','')} ({c.get('expression','')})"
            for c in shot.characters[:2] if c.get('name')
        ]
        if char_descs:
            intro_parts.append(", ".join(char_descs))
    if shot.emotion:
        intro_parts.append(shot.emotion)
    intro_prompt = ". ".join(filter(None, intro_parts)) or "cinematic scene"

    motion_prompt = shot.motion_prompt or f"camera {shot.camera.movement if shot.camera else 'static'}"

    return [intro_prompt, motion_prompt], [half_f, motion_f]


# ── Public API ─────────────────────────────────────────────────────────────────

def build_ltx_director_shot_workflow(
    shot: CinematicShot,
    first_frame_comfyui_name: str,
    last_frame_comfyui_name: str,
    output_prefix: str,
    audio_comfyui_name: Optional[str] = None,
    audio_start_sec: float = 0.0,
    width: int = 1280,
    height: int = 720,
    fps: int = 24,
    cfg: Optional[LTXDirectorConfig] = None,
) -> dict:
    """
    Build a ComfyUI workflow dict for a single CinematicShot using LTX Director.

    Maps CinematicShot fields to LTX Director parameters:
    - global_prompt: ltx_global_prompt if available, else assembled from cinematic fields
    - Two segments: intro (first half, rich scene+character prompt) and motion (second half)
    - Guide frames: first_frame at frame 0, last_frame at the final frame
    - Audio: trimmed to shot.duration_sec starting at audio_start_sec

    Returns a ready-to-submit workflow dict (not JSON string).
    """
    if cfg is None:
        cfg = LTXDirectorConfig(frame_rate=fps)

    use_audio    = bool(audio_comfyui_name)
    total_sec    = max(1.0, shot.duration_sec)
    total_frames = max(2, round(total_sec * fps))
    last_frame_idx = total_frames - 1

    # Prompts / segments
    seg_prompts, seg_frames = _build_shot_local_prompts(shot)
    # Adjust segment frames to match total_frames precisely
    seg_frames[-1] = total_frames - sum(seg_frames[:-1])

    local_prompts_str   = "|".join(seg_prompts)
    segment_lengths_str = ",".join(str(f) for f in seg_frames)

    # Guide frame definitions for timeline_data
    guide_frames = [
        {
            "frame":     0,
            "imagePath": first_frame_comfyui_name,
            "strength":  1.0,
            "type":      "image",
        },
        {
            "frame":     last_frame_idx,
            "imagePath": last_frame_comfyui_name,
            "strength":  1.0,
            "type":      "image",
        },
    ]
    timeline_data = _build_timeline_data(seg_prompts, seg_frames, guide_frames)

    global_prompt = _compose_global_prompt(shot)

    # ── Assemble workflow ────────────────────────────────────────────────────
    workflow: dict = {}

    # Loaders
    workflow.update(_loader_nodes(cfg))

    # Image guide loaders
    workflow.update(_image_loader_node(_IMG_BASE,     first_frame_comfyui_name))
    workflow.update(_image_loader_node(_IMG_BASE + 1, last_frame_comfyui_name))

    # Optional audio loader
    if use_audio:
        workflow.update(_audio_nodes(audio_comfyui_name, audio_start_sec))

    # Core director + conditioning
    workflow.update(_core_nodes(
        cfg            = cfg,
        global_prompt  = global_prompt,
        local_prompts_str   = local_prompts_str,
        segment_lengths_str = segment_lengths_str,
        total_frames   = total_frames,
        total_seconds  = total_sec,
        width          = width,
        height         = height,
        use_audio      = use_audio,
        timeline_data  = timeline_data,
    ))

    # Sampling stages
    workflow.update(_stage1_nodes(cfg))
    workflow.update(_stage2_nodes(cfg))

    # Output
    workflow.update(_output_nodes(output_prefix, use_audio))

    return workflow


def build_ltx_director_full_video_workflow(
    shots: list[CinematicShot],
    story_arc: Optional[StoryArc],
    audio_analysis: Optional[AudioAnalysis],
    audio_comfyui_name: Optional[str],
    output_prefix: str,
    width: int = 1280,
    height: int = 720,
    fps: int = 24,
    cfg: Optional[LTXDirectorConfig] = None,
) -> dict:
    """
    Build a workflow for the ENTIRE video in one LTX Director pass.

    This is the most powerful mode: the full timeline is generated as a single
    latent, which preserves temporal coherence across shot boundaries.

    - global_prompt: story arc logline + visual motifs + style
    - local_prompts: one prompt per shot (pipe-separated), enriched with
                     lyrics_segment when present
    - segment_lengths: per-shot frame counts (comma-separated)
    - Guide frames: first_frame of every shot placed at its timeline start;
                    last_frame placed at its timeline end (minus 1)
    - Audio: full audio track trimmed to total video duration

    Returns a ready-to-submit workflow dict.
    """
    if cfg is None:
        cfg = LTXDirectorConfig(frame_rate=fps)
    if not shots:
        raise ValueError("Cannot build full-video workflow: shots list is empty")

    use_audio = bool(audio_comfyui_name)

    # ── Calculate per-shot frame counts ─────────────────────────────────────
    seg_frames: list[int] = []
    for s in shots:
        f = max(1, round(max(1.0, s.duration_sec) * fps))
        seg_frames.append(f)

    total_frames  = sum(seg_frames)
    total_seconds = total_frames / fps

    # ── Per-shot local prompts ───────────────────────────────────────────────
    seg_prompts: list[str] = []
    for s in shots:
        base = s.scene_description or s.emotion or "cinematic scene"
        if s.lyrics_segment:
            base = f"{s.lyrics_segment}. {base}"
        motion = s.motion_prompt or (
            f"camera {s.camera.movement}" if s.camera else "camera static"
        )
        # Single combined prompt per shot
        seg_prompts.append(f"{base}. {motion}")

    # ── Guide frames ─────────────────────────────────────────────────────────
    guide_frames: list[dict] = []
    cursor = 0
    img_nodes: dict = {}

    for i, (shot, count) in enumerate(zip(shots, seg_frames)):
        first_name = (
            shot.first_frame.image_path.split("/")[-1].split("\\")[-1]
            if shot.first_frame and shot.first_frame.image_path
            else None
        )
        last_name = (
            shot.last_frame.image_path.split("/")[-1].split("\\")[-1]
            if shot.last_frame and shot.last_frame.image_path
            else None
        )

        start_frame = cursor
        end_frame   = cursor + count - 1

        if first_name:
            node_id = str(_IMG_BASE + i * 2)
            img_nodes[node_id] = {
                "class_type": "LoadImage",
                "inputs": {"image": first_name, "upload": "image"},
                "_meta": {"title": f"First Frame shot {i+1}"},
            }
            guide_frames.append({
                "frame":     start_frame,
                "imagePath": first_name,
                "strength":  1.0,
                "type":      "image",
            })

        if last_name:
            node_id = str(_IMG_BASE + i * 2 + 1)
            img_nodes[node_id] = {
                "class_type": "LoadImage",
                "inputs": {"image": last_name, "upload": "image"},
                "_meta": {"title": f"Last Frame shot {i+1}"},
            }
            guide_frames.append({
                "frame":     end_frame,
                "imagePath": last_name,
                "strength":  1.0,
                "type":      "image",
            })

        cursor += count

    # ── Timeline data ─────────────────────────────────────────────────────────
    timeline_data = _build_timeline_data(seg_prompts, seg_frames, guide_frames)

    # ── Global prompt ─────────────────────────────────────────────────────────
    global_prompt = _compose_global_prompt_full(shots, story_arc)

    local_prompts_str   = "|".join(seg_prompts)
    segment_lengths_str = ",".join(str(f) for f in seg_frames)

    # ── Assemble workflow ─────────────────────────────────────────────────────
    workflow: dict = {}

    workflow.update(_loader_nodes(cfg))
    workflow.update(img_nodes)

    if use_audio:
        workflow.update(_audio_nodes(audio_comfyui_name, 0.0))

    workflow.update(_core_nodes(
        cfg                 = cfg,
        global_prompt       = global_prompt,
        local_prompts_str   = local_prompts_str,
        segment_lengths_str = segment_lengths_str,
        total_frames        = total_frames,
        total_seconds       = total_seconds,
        width               = width,
        height              = height,
        use_audio           = use_audio,
        timeline_data       = timeline_data,
    ))

    workflow.update(_stage1_nodes(cfg))
    workflow.update(_stage2_nodes(cfg))
    workflow.update(_output_nodes(output_prefix, use_audio))

    return workflow
