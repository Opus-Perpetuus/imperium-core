from __future__ import annotations

import os
import stat

from imperium_cli import config


def test_config_0600(config_home):
    data = config.upsert_profile({"perfiles": {}}, "lab", {"url": "http://x", "token": "icli_z"}, activate=True)
    path = config.save(data)
    assert path == config_home / "imperium" / "config.json"
    mode = stat.S_IMODE(path.stat().st_mode)
    assert mode == 0o600
    loaded = config.load()
    assert loaded["perfil_activo"] == "lab"
    assert config.get_profile(loaded)["url"] == "http://x"


def test_imperium_config_override(tmp_path, monkeypatch):
    custom = tmp_path / "mio.json"
    monkeypatch.setenv("IMPERIUM_CONFIG", str(custom))
    config.save({"perfil_activo": "a", "perfiles": {"a": {"url": "http://z"}}})
    assert custom.is_file()
    assert config.load()["perfiles"]["a"]["url"] == "http://z"
