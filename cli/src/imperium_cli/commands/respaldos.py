from __future__ import annotations

from pathlib import Path

from ..exits import CliError, VALIDACION
from ..httpc import request
from .common import api, confirm, emit, require_session


def listar(args) -> int:
    _s, _h, body = api(args, "GET", "/api/db-admin/backups")
    rows = body.get("data") if isinstance(body, dict) else body
    return emit(body, as_json=args.json, text=_list_text(rows))


def crear(args) -> int:
    if args.dry_run:
        return emit({"dry_run": True, "path": "POST /api/db-admin/backups"}, as_json=args.json, text="[dry-run] POST /api/db-admin/backups")
    confirm(args, "¿Crear un respaldo de la base ahora?")
    body = {"label": getattr(args, "etiqueta", None) or getattr(args, "label", None)}
    _s, _h, res = api(args, "POST", "/api/db-admin/backups", body={k: v for k, v in body.items() if v})
    return emit(res, as_json=args.json, text=str((res or {}).get("message") or "Respaldo en curso."))


def verificar(args) -> int:
    if not args.id:
        raise CliError("Falta el id del respaldo.", VALIDACION)
    _s, _h, res = api(args, "POST", f"/api/db-admin/backups/{args.id}/verify", body={})
    return emit(res, as_json=args.json, text=str((res or {}).get("message") or "Verificado."))


def descargar(args) -> int:
    if not args.id:
        raise CliError("Falta el id del respaldo.", VALIDACION)
    _, _, profile = require_session(args)
    dest = Path(args.salida or args.id).expanduser()
    if args.dry_run:
        return emit({"dry_run": True, "id": args.id, "salida": str(dest)}, as_json=args.json, text=f"[dry-run] GET /api/db-admin/backups/{args.id}/download → {dest}")
    status, headers, raw = request(
        profile["url"],
        "GET",
        f"/api/db-admin/backups/{args.id}/download",
        token=profile.get("token"),
        accept="application/x-tar",
    )
    if status >= 400:
        from ..exits import code_for_status

        raise CliError(f"No se pudo descargar el respaldo ({status}).", code_for_status(status), status=status)
    dest.write_bytes(raw)
    return emit(
        {"ok": True, "id": args.id, "salida": str(dest), "bytes": len(raw)},
        as_json=args.json,
        text=f"Guardado en {dest} ({len(raw)} bytes).",
    )


def _list_text(rows) -> str:
    if not isinstance(rows, list) or not rows:
        return "Sin respaldos."
    lines = []
    for row in rows:
        if isinstance(row, dict):
            ident = row.get("id") or row.get("name") or ""
            lines.append(f"{ident}  {row.get('created_at') or row.get('label') or ''}")
        else:
            lines.append(str(row))
    return "\n".join(lines)
