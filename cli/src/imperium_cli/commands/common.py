from __future__ import annotations

import json
import sys
from typing import Any

from .. import config
from ..exits import CliError, SIN_SESION, USO
from ..httpc import request_json


def emit(data: Any, *, as_json: bool, text: str | None = None) -> int:
    if as_json:
        json.dump(data, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    elif text:
        sys.stdout.write(text if text.endswith("\n") else text + "\n")
    else:
        json.dump(data, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    return 0


def require_profile(args) -> tuple[dict[str, Any], str, dict[str, Any]]:
    data = config.load()
    name = config.profile_name(data, getattr(args, "perfil", None))
    profile = config.get_profile(data, name)
    if not profile or not profile.get("url"):
        raise CliError(
            f"No hay perfil «{name}». Corre: imperium iniciar-sesion --url …",
            SIN_SESION,
        )
    return data, name, profile


def require_session(args) -> tuple[dict[str, Any], str, dict[str, Any]]:
    data, name, profile = require_profile(args)
    if not profile.get("token"):
        raise CliError(
            f"El perfil «{name}» no tiene sesión. Corre: imperium iniciar-sesion",
            SIN_SESION,
        )
    return data, name, profile


def api(args, method: str, path: str, body: Any = None):
    _, _, profile = require_session(args)
    return request_json(profile["url"], method, path, token=profile.get("token"), body=body)


def confirm(args, message: str) -> None:
    if getattr(args, "yes", False) or getattr(args, "si", False):
        return
    try:
        answer = input(f"{message} [s/N] ").strip().lower()
    except EOFError as err:
        raise CliError("Se necesita confirmación.", USO) from err
    if answer not in {"s", "si", "sí", "y", "yes"}:
        raise CliError("Operación cancelada.", USO)


def slug_tid(slug: str) -> str:
    value = slug.strip()
    if value.startswith("subject-"):
        return value
    return f"subject-{value}"
