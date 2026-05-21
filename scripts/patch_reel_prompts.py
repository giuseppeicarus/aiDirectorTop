"""
Rebuilds generation prompts for an existing reel checkpoint using the
director's EDL visual_hints + narrative, WITHOUT calling any LLM.

Usage:
  python scripts/patch_reel_prompts.py <job_id>
  python scripts/patch_reel_prompts.py 57949df8ec
"""
import sys
import json
import math
from pathlib import Path

STUDIO_DIR = Path.home() / ".cinematic-studio"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
NEGATIVE = (
    "blurry, low quality, artifacts, text, watermark, logo, animated, cartoon, "
    "deformed, distorted, ugly, nsfw, bad anatomy, extra limbs"
)


def finalize(prompt: str) -> str:
    suffix = (
        "photorealistic, 8k, sharp focus, cinematic color grade, "
        "professional photography, award-winning cinematography"
    )
    if suffix.split(",")[0].strip() not in prompt:
        prompt = prompt.rstrip(", ") + ", " + suffix
    return prompt


ENERGY_TO_SHOT = {"low": "medium", "medium": "medium_close", "high": "close_up", "peak": "extreme_close"}
ENERGY_TO_MOVE = {"low": "slow dolly in", "medium": "gentle push forward", "high": "handheld tracking", "peak": "rapid push in"}
ENERGY_TO_LENS = {"low": 85, "medium": 50, "high": 35, "peak": 24}


def rebuild_clip_prompts(checkpoint: dict) -> list[dict]:
    edl = checkpoint.get("edl") or {}
    slots_raw = edl.get("slots") if isinstance(edl, dict) else []
    if not slots_raw:
        print("ERROR: no EDL slots found")
        return []

    dn = checkpoint.get("director_narrative") or {}
    mood = dn.get("mood", "cinematic")
    visual_theme = dn.get("visual_theme", "")
    motifs = dn.get("visual_motifs") or []
    motif_str = "; ".join(str(m) for m in motifs[:3])
    style = checkpoint.get("vision", {}).get("combined_style", "adv video, photorealistic")
    char_anchors = checkpoint.get("vision", {}).get("character_anchors") or []
    anchor_str = ". ".join(char_anchors[:2]) if char_anchors else ""

    # Build a slot_id → rich prompt mapping
    slot_prompts: dict[str, dict] = {}
    for sl in slots_raw:
        slot_id = sl["slot_id"]
        visual_hint = (sl.get("visual_hint") or "").strip()
        emotion = (sl.get("emotion") or "cinematic").strip()
        energy = (sl.get("energy") or "medium").lower()
        shot = ENERGY_TO_SHOT.get(energy, "medium")
        move = ENERGY_TO_MOVE.get(energy, "slow dolly in")
        lens = ENERGY_TO_LENS.get(energy, 50)
        dof = "shallow" if energy in ("high", "peak") else "medium"
        lighting = f"warm golden directional light, chiaroscuro, {mood}"

        # First frame: exact visual_hint from director
        ff_parts = [f"{style}, {shot} shot"]
        if anchor_str:
            ff_parts.append(anchor_str)
        if visual_hint:
            ff_parts.append(visual_hint[:200])
        if motif_str:
            ff_parts.append(motif_str)
        ff_parts.extend([lighting, f"cinematic, {mood}", f"{lens}mm lens, {dof} depth of field"])
        ff = finalize(", ".join(p.strip() for p in ff_parts if p.strip()))

        # Last frame: progression / resolution of the visual hint
        lf_desc = f"{visual_hint[:160]}, moment of resolution" if visual_hint else f"{emotion}, resolution"
        lf_parts = [f"{style}, {shot} shot"]
        if anchor_str:
            lf_parts.append(anchor_str)
        lf_parts.extend([lf_desc, lighting, f"cinematic, {mood}", f"{lens}mm lens, {dof} depth of field"])
        lf = finalize(", ".join(p.strip() for p in lf_parts if p.strip()))

        # Scene prompt (for storyboard)
        sp_parts = [f"{style}, {shot} shot"]
        if visual_hint:
            sp_parts.append(visual_hint[:180])
        sp_parts.extend([lighting, mood])
        scene_prompt = finalize(", ".join(p.strip() for p in sp_parts if p.strip()))

        motion = f"{move}, {emotion.lower()}"

        slot_prompts[slot_id] = {
            "scene_prompt": scene_prompt,
            "first_frame_prompt": ff,
            "last_frame_prompt": lf,
            "motion_prompt": motion[:80],
            "negative_prompt": NEGATIVE,
        }

    # Patch every clip in clips_list
    clips_list = checkpoint.get("clips_list") or []
    updated = []
    for clip in clips_list:
        slot_id = clip.get("slot_id")
        p = slot_prompts.get(slot_id)
        if p:
            clip = {**clip, **p}
            print(f"  PATCHED {clip['clip_id']}")
            print(f"    ff: {clip['first_frame_prompt'][:100]}")
        else:
            print(f"  SKIP {clip.get('clip_id')} (no slot_id match)")
        updated.append(clip)
    return updated


def main():
    job_id = sys.argv[1] if len(sys.argv) > 1 else "57949df8ec"
    # Clean up job_id prefix
    if job_id.startswith("reel_"):
        job_id = job_id[5:]

    checkpoint_path = STUDIO_DIR / f"projects/reel_{job_id}/reel_state_{job_id}.json"
    if not checkpoint_path.exists():
        print(f"ERROR: checkpoint not found: {checkpoint_path}")
        sys.exit(1)

    checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    print(f"Loaded checkpoint for job {job_id}, phase={checkpoint.get('phase')}")

    dn = checkpoint.get("director_narrative") or {}
    print(f"Director logline: {str(dn.get('logline',''))[:80]}")
    print(f"Director mood: {dn.get('mood','')}")
    print()

    print("Rebuilding prompts from director's visual hints...")
    new_clips = rebuild_clip_prompts(checkpoint)
    if not new_clips:
        print("ERROR: no clips rebuilt")
        sys.exit(1)

    checkpoint["clips_list"] = new_clips
    # Reset phase to 5 so storyboard will be regenerated from new prompts
    checkpoint["phase"] = 5
    checkpoint["storyboard_approved"] = False

    # Backup original
    backup = checkpoint_path.with_suffix(".json.bak")
    backup.write_text(checkpoint_path.read_text(encoding="utf-8"), encoding="utf-8")
    print(f"\nBackup saved to {backup}")

    checkpoint_path.write_text(json.dumps(checkpoint, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Checkpoint patched and saved (phase=5).")
    print()
    print("Next: trigger phase='storyboard' to regenerate storyboard from new prompts.")
    print(f"  POST /api/reel/generate  resume_job_id={job_id}  phase=storyboard")


if __name__ == "__main__":
    main()
