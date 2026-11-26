from __future__ import annotations

from ..exits import CliError, VALIDACION
from .common import api, confirm, emit, slug_tid


def listar(args) -> int:
    _status, _headers, body = api(args, "GET", "/api/subjects")
    rows = body.get("data") if isinstance(body, dict) else body
    return emit(body, as_json=args.json, text=_table(rows, ["slug", "name", "installed", "version"]))


def motivo(args) -> int:
    tid = slug_tid(args.slug)
    _status, _headers, body = api(args, "GET", f"/api/subjects/{tid}")
    row = body.get("data") if isinstance(body, dict) else body
    return emit(body, as_json=args.json, text=_motivo_text(row))


def instalar(args) -> int:
    return _mutate(args, "install", f"Instalar {args.slug}?")


def desinstalar(args) -> int:
    return _mutate(args, "uninstall", f"Desinstalar {args.slug}?")


def actualizar(args) -> int:
    if getattr(args, "slug", None):
        tid = slug_tid(args.slug)
        path = f"/api/subjects/{tid}/update"
        message = f"Actualizar {args.slug}?"
    else:
        tid = None
        path = "/api/subjects/updates/apply"
        message = "Actualizar todas las apps con versión nueva?"
    if args.dry_run:
        return emit({"dry_run": True, "path": "POST " + path, "slug": args.slug if tid else "*"}, as_json=args.json, text=f"[dry-run] POST {path}")
    confirm(args, message)
    _status, _headers, body = api(args, "POST", path, body={})
    return emit(body, as_json=args.json, text=str((body or {}).get("message") or "Actualización enviada."))


def _mutate(args, action: str, message: str) -> int:
    if not getattr(args, "slug", None):
        raise CliError("Falta el slug de la app.", VALIDACION)
    tid = slug_tid(args.slug)
    path = f"/api/subjects/{tid}/{action}"
    if args.dry_run:
        return emit({"dry_run": True, "path": "POST " + path}, as_json=args.json, text=f"[dry-run] POST {path}")
    confirm(args, message)
    _status, _headers, body = api(args, "POST", path, body={})
    return emit(body, as_json=args.json, text=str((body or {}).get("message") or action))


def _motivo_text(row) -> str:
    if not isinstance(row, dict):
        return str(row)
    for key in ("install_error", "error", "motivo", "last_error", "message"):
        if row.get(key):
            return f"{row.get('name') or row.get('slug') or ''}: {row[key]}"
    return str(row.get("name") or row.get("slug") or "Sin motivo de error.")


def _table(rows, keys) -> str:
    if not isinstance(rows, list) or not rows:
        return "Sin apps."
    lines = []
    for row in rows:
        if not isinstance(row, dict):
            lines.append(str(row))
            continue
        parts = [str(row.get(k, row.get("technical_id", ""))) for k in keys if row.get(k) is not None]
        if not parts:
            parts = [str(row.get("name") or row.get("slug") or row.get("technical_id") or row)]
        lines.append(" · ".join(parts))
    return "\n".join(lines)
