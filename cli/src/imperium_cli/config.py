"""Perfiles locales: URL, token, usuario y dispositivo. Fichero en modo 0600.

Si `keyring` está instalado (y `IMPERIUM_KEYRING` no es 0) el token va al
llavero del sistema y el fichero solo guarda `token_ref`.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .exits import PERMISO, CliError

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


KEYRING_SERVICE = "imperium-cli"


def _keyring():
    if os.environ.get("IMPERIUM_KEYRING", "").strip() in ("0", "no", "false"):
        return None
    try:
        import keyring  # type: ignore[import-not-found]
    except Exception:
        return None
    return keyring


def _ref(name: str, url: str | None) -> str:
    return f"{name}@{(url or '').rstrip('/')}"


def _resolve_tokens(data: dict[str, Any]) -> dict[str, Any]:
    kr = _keyring()
    for row in (data.get("perfiles") or {}).values():
        if isinstance(row, dict) and row.get("token_ref") and not row.get("token") and kr is not None:
            try:
                row["token"] = kr.get_password(KEYRING_SERVICE, row["token_ref"])
            except Exception:
                row["token"] = None
    return data


def _stash_tokens(data: dict[str, Any]) -> dict[str, Any]:
    kr = _keyring()
    out = json.loads(json.dumps(data))
    for name, row in (out.get("perfiles") or {}).items():
        if not isinstance(row, dict) or kr is None:
            continue
        if not row.get("token"):
            if row.get("token_ref"):
                forget_token(row)
                row.pop("token_ref", None)
            continue
        ref = row.get("token_ref") or _ref(name, row.get("url"))
        try:
            kr.set_password(KEYRING_SERVICE, ref, row["token"])
        except Exception:
            continue
        row["token_ref"], row["token"] = ref, None
    return out


def forget_token(row: dict[str, Any] | None) -> None:
    kr = _keyring()
    if kr is not None and isinstance(row, dict) and row.get("token_ref"):
        try:
            kr.delete_password(KEYRING_SERVICE, row["token_ref"])
        except Exception:
            pass


def load(path: Path | None = None) -> dict[str, Any]:
    target = path or config_path()
    if not target.is_file():
        return {"perfil_activo": "default", "perfiles": {}}
    data = json.loads(target.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        return {"perfil_activo": "default", "perfiles": {}}
    data.setdefault("perfil_activo", "default")
    data.setdefault("perfiles", {})
    return _resolve_tokens(data)


class ConfigNotWritable(CliError):
    """El directorio de configuración no es escribible por este usuario."""

    def __init__(self, message: str):
        super().__init__(message, PERMISO)


def _chmod_if_owned(target: Path, mode: int) -> None:
    # Solo el dueño (o root) puede cambiar el modo; en volúmenes de Docker
    # creados por root el chmod da EPERM aunque se pueda escribir.
    try:
        if hasattr(os, "geteuid") and os.geteuid() not in (0, target.stat().st_uid):
            return
        os.chmod(target, mode)
    except OSError:
        pass


def save(data: dict[str, Any], path: Path | None = None) -> Path:
    target = path or config_path()
    folder = target.parent
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ConfigNotWritable(f"No puedo crear {folder}: {exc.strerror}") from exc
    _chmod_if_owned(folder, DIR_MODE)
    if not os.access(folder, os.W_OK | os.X_OK):
        raise ConfigNotWritable(
            f"No puedo escribir en {folder} (dueño uid {folder.stat().st_uid}, yo uid {os.geteuid()}). "
            f"Corrige el permiso (p. ej. chown {os.geteuid()} {folder}) o usa IMPERIUM_CONFIG=<ruta>."
        )
    tmp = target.with_suffix(target.suffix + ".tmp")
    payload = json.dumps(_stash_tokens(data), ensure_ascii=False, indent=2) + "\n"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, CONFIG_MODE)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(payload)
    _chmod_if_owned(tmp, CONFIG_MODE)
    tmp.replace(target)
    _chmod_if_owned(target, CONFIG_MODE)
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
    forget_token(perfiles.pop(name, None))
    if data.get("perfil_activo") == name:
        data["perfil_activo"] = next(iter(perfiles), "default")
    return data
