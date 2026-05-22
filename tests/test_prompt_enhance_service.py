"""Routing Migliora prompt → ruolo LLM pipeline."""

from src.core.llm.prompt_enhance_service import resolve_enhance_context


def test_reel_scene_uses_narrative_director():
    role, ctx, tool = resolve_enhance_context("scene_prompt")
    assert role == "narrative_director"
    assert ctx == "scene_prompt"
    assert tool == "txt2img"


def test_reel_motion_uses_cinematographer():
    role, ctx, tool = resolve_enhance_context("motion_prompt")
    assert role == "cinematographer"
    assert ctx == "motion_prompt"
    assert tool == "img2video"


def test_reel_ltx_uses_prompt_engineer():
    role, _, tool = resolve_enhance_context("ltx_video_prompt")
    assert role == "prompt_engineer"
    assert tool == "img_audio2video"


def test_tools_img2video_via_tool_arg():
    role, ctx, tool = resolve_enhance_context("ignored", tool="img2video")
    assert role == "cinematographer"
    assert ctx == "img2video"
    assert tool == "img2video"


def test_director_global_narrative():
    role, _, _ = resolve_enhance_context("director_global")
    assert role == "narrative_director"
