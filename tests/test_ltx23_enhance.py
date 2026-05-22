"""Test Migliora prompt + memoria LTX 2.3."""

from src.core.llm.ltx23_prompt_builder import (
    LTX23_FULL_PARAGRAPH_CONTEXTS,
    enhance_apply_ltx23_postprocess,
)
from src.core.obsidian.context_for_llm import resolve_enhance_memory_stage
from src.core.obsidian.ltx23_guide import LTX23_GUIDE_MARKDOWN, ensure_ltx23_guide_in_vault


def test_ltx_contexts_include_tools():
    assert "txt2video" in LTX23_FULL_PARAGRAPH_CONTEXTS
    assert "img2video" in LTX23_FULL_PARAGRAPH_CONTEXTS
    assert "img_audio2video" in LTX23_FULL_PARAGRAPH_CONTEXTS


def test_enhance_postprocess_fixes_junk():
    bad = (
        "The camera dollies. wide shot. The scene shows head dow. "
        "photorealistic cinematic realism."
    )
    out = enhance_apply_ltx23_postprocess(
        bad,
        "img2video",
        project_context={
            "shot_type": "wide",
            "camera_movement": "dolly_in",
            "duration_sec": 5,
            "description": "rap artist in leather jacket",
        },
    )
    assert "the scene shows" not in out.lower()
    assert "sound:" in out.lower()


def test_resolve_enhance_memory_stage():
    assert resolve_enhance_memory_stage("img_audio2video") == "img_audio2video_enhance"
    assert resolve_enhance_memory_stage("txt2video") == "txt2video_enhance"


def test_vault_guide_written(tmp_path):
    p = ensure_ltx23_guide_in_vault(tmp_path)
    assert p.is_file()
    text = p.read_text(encoding="utf-8")
    assert "LTX 2.3" in text
    assert len(LTX23_GUIDE_MARKDOWN) > 500
