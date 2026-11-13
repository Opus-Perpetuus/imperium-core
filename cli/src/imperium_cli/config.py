"""Perfiles locales: URL, token, usuario y dispositivo. Fichero en modo 0600."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

CONFIG_MODE = 0o600
DIR_MODE = 0o700


def config_path(override: str | None = None) -> Path:
    if override:
        return Path(override).expanduser()
    explicit = os.environ.get("IMPERIUM_CONFIG", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    xdg = os.environ.get("XDG_CONFIG_HOME", "").strip()
    base = Path(xdg).expanduser() if xdg else Path.home() / ".config"
    return base / "imperium" / "config.json"


def load(path: Path | None = None) -> dict[str, Any]:
    target = path or config_path()
    if not target.is_file():
        return {"perfil_activo": "default", "perfiles": {}}
    data = json.loads(target.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        return {"perfil_activo": "default", "perfiles": {}}
    data.setdefault("perfil_activo", "default")
    data.setdefault("perfiles", {})
    return data


def save(data: dict[str, Any], path: Path | None = None) -> Path:
    target = path or config_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(target.parent, DIR_MODE)
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, CONFIG_MODE)
    tmp.replace(target)
    os.chmod(target, CONFIG_MODE)
    return target


def profile_name(data: dict[str, Any], requested: str | None = None) -> str:
    if requested:
        return requested
    env = os.environ.get("IMPERIUM_PERFIL", "").strip()
    if env:
        return env
    return str(data.get("perfil_activo") or "default")


def get_profile(data: dict[str, Any], name: str | None = None) -> dict[str, Any] | None:
    key = profile_name(data, name)
    perfiles = data.get("perfiles") or {}
    row = perfiles.get(key)
    return row if isinstance(row, dict) else None


def upsert_profile(data: dict[str, Any], name: str, profile: dict[str, Any], *, activate: bool = True) -> dict[str, Any]:
    data.setdefault("perfiles", {})
    data["perfiles"][name] = profile
    if activate:
        data["perfil_activo"] = name
    return data


def delete_profile(data: dict[str, Any], name: str) -> dict[str, Any]:
    perfiles = data.setdefault("perfiles", {})
    perfiles.pop(name, None)
    if data.get("perfil_activo") == name:
        data["perfil_activo"] = next(iter(perfiles), "default")
    return data
