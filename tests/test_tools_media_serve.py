"""Test salvataggio locale e serve HTTP tool output."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src.core.main import app
from src.core.api.tools_routes import _tools_dir


@pytest.fixture
def client():
    return TestClient(app)


def test_tools_output_serve_png(client, tmp_path, monkeypatch):
    tools = tmp_path / "tools"
    tools.mkdir()
    png = tools / "tool_test123.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 400)

    monkeypatch.setattr("src.core.api.tools_routes._tools_dir", lambda: tools)

    r = client.get("/api/tools/output/tool_test123.png")
    assert r.status_code == 200
    assert r.headers.get("content-type", "").startswith("image/")
    assert len(r.content) > 200


def test_tools_output_not_found(client, tmp_path, monkeypatch):
    tools = tmp_path / "tools_empty"
    tools.mkdir()
    monkeypatch.setattr("src.core.api.tools_routes._tools_dir", lambda: tools)
    assert client.get("/api/tools/output/missing.png").status_code == 404
