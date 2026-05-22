"""Test helper matching per verifica modelli LM Studio."""

from src.core.llm.model_probe import (
    _collect_loaded_instance_ids,
    _extract_message_text,
    _instance_loaded_anywhere,
    _model_keys_match,
    _model_loaded_in_list,
    _openai_model_ready,
)


def test_model_keys_match_variants():
    assert _model_keys_match(
        "google_gemma-4-e4b-it",
        "indiansatoshi/google_gemma-4-e4b-it",
    )
    assert not _model_keys_match("publisher/model-a", "publisher/model-b")
    assert _model_keys_match("llama3", "meta/llama3")


def test_collect_loaded_instance_ids():
    catalog = [
        {"key": "a", "loaded_instances": [{"id": "inst-a"}]},
        {"key": "b", "loaded_instances": [{"id": "inst-b"}, {"id": "inst-a"}]},
    ]
    assert _collect_loaded_instance_ids(catalog) == ["inst-a", "inst-b"]


def test_instance_loaded_anywhere_without_key_match():
    catalog = [
        {
            "key": "lmstudio-community/qwen3.5-9b-gguf",
            "loaded_instances": [],
        },
        {
            "key": "other/publisher",
            "loaded_instances": [{"id": "qwen3.5-9b-custom-id", "config": {}}],
        },
    ]
    assert not _model_loaded_in_list(catalog, "my/studio/model-name")
    assert _instance_loaded_anywhere(
        catalog, "my/studio/model-name", instance_id="qwen3.5-9b-custom-id"
    )


def test_extract_message_text_qwen_reasoning():
    msg = {
        "role": "assistant",
        "content": "",
        "reasoning_content": 'Planning JSON: {"status":"ok","role":"probe"}',
    }
    assert "status" in _extract_message_text(msg)
    assert _extract_message_text({"role": "assistant", "content": "hello"}) == "hello"


def test_openai_model_ready():
    ids = ["lmstudio-community/Qwen3.5-9B-GGUF"]
    assert _openai_model_ready(ids, "qwen3.5-9b")
    assert not _openai_model_ready(ids, "llama-3")


def test_model_loaded_in_list():
    catalog = [
        {
            "key": "google/gemma-4-26b",
            "loaded_instances": [{"id": "google/gemma-4-26b", "config": {}}],
        }
    ]
    assert _model_loaded_in_list(catalog, "google/gemma-4-26b")
    assert not _model_loaded_in_list(catalog, "other/model")
    assert _model_loaded_in_list(
        catalog, "google/gemma-4-26b", instance_id="google/gemma-4-26b"
    )
