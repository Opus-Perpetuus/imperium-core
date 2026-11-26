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


def test_save_skips_chmod_on_foreign_dir(config_home, monkeypatch):
    """Volumen de Docker creado por root: chmod da EPERM pero sí se puede escribir."""
    real_chmod = os.chmod

    def chmod(path, mode, *a, **kw):
        if os.path.isdir(path):
            raise PermissionError(1, "Operation not permitted", str(path))
        return real_chmod(path, mode, *a, **kw)

    monkeypatch.setattr(config.os, "chmod", chmod)
    path = config.save({"perfil_activo": "a", "perfiles": {"a": {"url": "http://z"}}})
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert config.load()["perfiles"]["a"]["url"] == "http://z"


def test_save_clear_error_when_dir_not_writable(config_home, monkeypatch):
    import pytest

    folder = config_home / "imperium"
    folder.mkdir(parents=True)
    monkeypatch.setattr(config.os, "access", lambda *a, **kw: False)
    with pytest.raises(config.ConfigNotWritable) as err:
        config.save({"perfiles": {}})
    assert "No puedo escribir" in str(err.value) and err.value.code == 5
