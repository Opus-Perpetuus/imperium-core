from __future__ import annotations

import json
import sys
from typing import Any

from .. import config
from ..exits import CliError, SIN_SESION, USO, VALIDACION
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


def rows_of(body: Any) -> list[dict[str, Any]]:
    rows = body.get("data") if isinstance(body, dict) else body
    if isinstance(rows, dict):
        return [rows]
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def kv_pairs(items: list[str] | None, what: str = "--campo") -> dict[str, str]:
    out: dict[str, str] = {}
    for item in items or []:
        key, sep, value = item.partition("=")
        if not sep or not key.strip():
            raise CliError(f"{what} espera clave=valor (recibí «{item}»).", VALIDACION)
        out[key.strip()] = value
    return out


def query(params: dict[str, Any]) -> str:
    from urllib.parse import urlencode

    clean = {k: v for k, v in params.items() if v not in (None, "", False)}
    return ("?" + urlencode(clean)) if clean else ""


def table_text(rows: list[dict[str, Any]], columns: list[str] | None = None, empty: str = "Sin registros.") -> str:
    if not rows:
        return empty
    cols = columns or [k for k in rows[0].keys() if not str(k).startswith("__")][:6]
    lines = ["\t".join(cols)]
    for row in rows:
        lines.append("\t".join(_cell(row.get(c)) for c in cols))
    return "\n".join(lines)


def _cell(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("name") or value.get("codigo") or value.get("_id") or "")
    if value is None:
        return ""
    return str(value)


def dry_or_confirm(args, plan: dict[str, Any], text: str, question: str) -> bool:
    """True si hay que ejecutar. Con --dry-run emite el plan y devuelve False."""
    if getattr(args, "dry_run", False):
        emit({"dry_run": True, **plan}, as_json=args.json, text=f"[dry-run] {text}")
        return False
    confirm(args, question)
    return True
