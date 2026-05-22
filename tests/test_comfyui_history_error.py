from src.core.comfyui.workflow_builder import extract_history_error


def test_extract_history_error_parses_execution_error():
    history = {
        "status": {
            "status_str": "error",
            "messages": [
                ["execution_start", {"prompt_id": "x"}],
                [
                    "execution_error",
                    {
                        "node_id": "76:63",
                        "node_type": "VAELoader",
                        "exception_message": "shape invalid\n",
                        "exception_type": "RuntimeError",
                    },
                ],
            ],
        }
    }
    err = extract_history_error(history)
    assert "VAELoader" in err
    assert "76:63" in err
    assert "shape invalid" in err
    assert "Z-Image" in err or "ae.safetensors" in err
