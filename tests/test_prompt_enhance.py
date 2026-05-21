"""Test estrazione prompt da risposte LLM eterogenee."""

from src.core.llm.prompt_enhance import (
    extract_enhanced_prompt,
    extract_negative_prompt,
    parse_enhance_llm_result,
    split_positive_and_negative,
)


def test_enhanced_key_plain():
    r = {"enhanced": "A woman on a beach, cinematic light"}
    assert extract_enhanced_prompt(r, "x") == "A woman on a beach, cinematic light"


def test_prompt_key_instead_of_enhanced():
    r = {
        "prompt": "Una donna sulla spiaggia",
        "negative_prompt": "cartoon, blurry",
        "image_ratio": "16:9",
    }
    assert extract_enhanced_prompt(r, "x") == "Una donna sulla spiaggia"
    assert extract_negative_prompt(r) == "cartoon, blurry"


def test_enhanced_value_is_stringified_json():
    inner = '{"prompt": "Nested prompt text", "negative_prompt": "bad"}'
    r = {"enhanced": inner}
    assert extract_enhanced_prompt(r, "x") == "Nested prompt text"
    assert extract_negative_prompt(r) == "bad"


def test_parse_fallback():
    assert parse_enhance_llm_result({"foo": 1}, "original")["enhanced"] == "original"


def test_unified_enhanced_includes_negative_block():
    parsed = parse_enhance_llm_result(
        {"enhanced": "Beach scene", "negative_prompt": "cartoon, blurry"},
        "x",
        tool="txt2img",
    )
    assert "--- Negative prompt ---" in parsed["enhanced"]
    assert parsed["enhanced"].endswith("cartoon, blurry")
    pos, neg = split_positive_and_negative(parsed["enhanced"], "")
    assert pos == "Beach scene"
    assert "cartoon" in neg


def test_llm_already_unified_string():
    unified = (
        "Cinematic beach\n\n--- Negative prompt ---\n"
        "cartoon, blurry, watermark"
    )
    parsed = parse_enhance_llm_result({"enhanced": unified}, "x", tool="txt2img")
    assert parsed["enhanced"] == unified
    pos, neg = split_positive_and_negative(parsed["enhanced"], "")
    assert pos == "Cinematic beach"
    assert "watermark" in neg
