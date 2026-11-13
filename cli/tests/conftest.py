from __future__ import annotations

import os
from pathlib import Path

import pytest


@pytest.fixture
def config_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "cfg"
    home.mkdir()
    monkeypatch.setenv("XDG_CONFIG_HOME", str(home))
    monkeypatch.delenv("IMPERIUM_CONFIG", raising=False)
    return home
