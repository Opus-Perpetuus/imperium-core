from __future__ import annotations

from .. import config
from ..exits import CliError, VALIDACION
from .common import emit, require_profile


def listar(args) -> int:
    data = config.load()
    activo = config.profile_name(data, None)
    perfiles = data.get("perfiles") or {}
    payload = {"activo": activo, "perfiles": {
        name: {k: v for k, v in row.items() if k not in ("token", "token_ref")} if isinstance(row, dict) else row
        for name, row in perfiles.items()
    }}
    lines = []
    for name, row in (perfiles or {}).items():
        mark = "*" if name == activo else " "
        url = row.get("url") if isinstance(row, dict) else ""
        email = (row.get("user") or {}).get("email") if isinstance(row, dict) else ""
        lines.append(f"{mark} {name}  {url}  {email}")
    return emit(payload, as_json=args.json, text="\n".join(lines) or "Sin perfiles.")


def usar(args) -> int:
    if not args.nombre:
        raise CliError("Falta el nombre del perfil.", VALIDACION)
    data = config.load()
    if args.nombre not in (data.get("perfiles") or {}):
        raise CliError(f"No existe el perfil «{args.nombre}».", VALIDACION)
    data["perfil_activo"] = args.nombre
    config.save(data)
    return emit({"ok": True, "perfil": args.nombre}, as_json=args.json, text=f"Perfil activo: {args.nombre}.")


def agregar(args) -> int:
    if not args.nombre or not args.url:
        raise CliError("Faltan --nombre y --url.", VALIDACION)
    data = config.load()
    config.upsert_profile(data, args.nombre, {"url": args.url.rstrip("/"), "token": None}, activate=bool(args.usar))
    config.save(data)
    return emit({"ok": True, "perfil": args.nombre, "url": args.url}, as_json=args.json, text=f"Perfil {args.nombre} agregado.")


def borrar(args) -> int:
    if not args.nombre:
        raise CliError("Falta el nombre del perfil.", VALIDACION)
    data = config.load()
    config.delete_profile(data, args.nombre)
    config.save(data)
    return emit({"ok": True, "perfil": args.nombre}, as_json=args.json, text=f"Perfil {args.nombre} borrado.")


def instancia(args) -> int:
    _data, name, profile = require_profile(args)
    safe = {k: v for k, v in profile.items() if k != "token"}
    safe["perfil"] = name
    return emit(safe, as_json=args.json, text=f"{name}  {profile.get('url')}  {((profile.get('user') or {}).get('email') or '')}")


def eliminar(args) -> int:
    return borrar(args)


def probar(args) -> int:
    from ..httpc import request_json
    from .estado import _health

    _data, name, profile = require_profile(args)
    out: dict = {"perfil": name, "url": profile["url"], "token": "llavero" if profile.get("token_ref") else ("archivo" if profile.get("token") else "sin token")}
    out["nucleo"] = (_health(profile["url"]) or {}).get("version")
    if profile.get("token"):
        try:
            request_json(profile["url"], "GET", "/api/auth/", token=profile["token"])
            out["sesion"] = "válida"
        except CliError as err:
            out["sesion"] = f"inválida: {err.message}"
    text = f"{name}  {profile['url']}  núcleo {out['nucleo'] or '?'}  sesión {out.get('sesion', 'sin token')}  token en {out['token']}"
    return emit(out, as_json=args.json, text=text)
