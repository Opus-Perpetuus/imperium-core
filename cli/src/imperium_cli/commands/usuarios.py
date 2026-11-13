from __future__ import annotations

from ..exits import CliError, VALIDACION
from .common import api, confirm, emit


def listar(args) -> int:
    _s, _h, body = api(args, "GET", "/api/user")
    return emit(body, as_json=args.json, text=_users_text(body))


def ver(args) -> int:
    if not args.id:
        raise CliError("Falta el id del usuario.", VALIDACION)
    _s, _h, body = api(args, "GET", f"/api/user/{args.id}")
    return emit(body, as_json=args.json, text=_one_text(body))


def crear(args) -> int:
    email = args.correo or args.email
    name = args.nombre or args.name
    if not email or not name:
        raise CliError("Faltan --nombre y --correo.", VALIDACION)
    payload = {"email": email, "name": name}
    if args.dry_run:
        return emit({"dry_run": True, "values": payload}, as_json=args.json, text=f"[dry-run] POST /api/user {email}")
    confirm(args, f"¿Crear el usuario {email}?")
    _s, _h, body = api(args, "POST", "/api/user", body=payload)
    return emit(body, as_json=args.json, text=str((body or {}).get("message") or "Usuario creado."))


def desactivar(args) -> int:
    if not args.id:
        raise CliError("Falta el id del usuario.", VALIDACION)
    if args.dry_run:
        return emit({"dry_run": True, "id": args.id}, as_json=args.json, text=f"[dry-run] PATCH /api/user/{args.id} is_active=false")
    confirm(args, f"¿Desactivar el usuario {args.id}?")
    _s, _h, body = api(args, "PATCH", f"/api/user/{args.id}", body={"is_active": False})
    return emit(body, as_json=args.json, text="Usuario desactivado.")


def reset_password(args) -> int:
    if not args.id:
        raise CliError("Falta el id del usuario.", VALIDACION)
    if args.dry_run:
        return emit({"dry_run": True, "id": args.id}, as_json=args.json, text=f"[dry-run] POST /api/user/{args.id}/recovery-link")
    confirm(args, f"¿Generar enlace de recuperación para {args.id}?")
    body = {"send_email": bool(getattr(args, "enviar_correo", False))}
    _s, _h, res = api(args, "POST", f"/api/user/{args.id}/recovery-link", body=body)
    return emit(res, as_json=args.json, text=str((res or {}).get("message") or "Enlace generado."))


def desbloquear(args) -> int:
    if not args.id:
        raise CliError("Falta el id del usuario.", VALIDACION)
    _s, _h, res = api(args, "POST", f"/api/user/{args.id}/unlock-auth", body={})
    return emit(res, as_json=args.json, text=str((res or {}).get("message") or "Desbloqueado."))


def grupos(args) -> int:
    _s, _h, body = api(args, "GET", "/api/user-group")
    return emit(body, as_json=args.json, text=_users_text(body))


def _users_text(body) -> str:
    rows = body.get("data") if isinstance(body, dict) else body
    if not isinstance(rows, list) or not rows:
        return "Sin registros."
    lines = []
    for row in rows:
        if isinstance(row, dict):
            lines.append(f"{row.get('_id') or row.get('id') or ''}  {row.get('name') or ''}  {row.get('email') or ''}")
        else:
            lines.append(str(row))
    return "\n".join(lines)


def _one_text(body) -> str:
    row = body.get("data") if isinstance(body, dict) else body
    if isinstance(row, list) and row:
        row = row[0]
    if isinstance(row, dict):
        return f"{row.get('name') or ''} <{row.get('email') or ''}> id={row.get('_id') or row.get('id')}"
    return str(row)
