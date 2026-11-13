from __future__ import annotations

import getpass
import os
from typing import Any

from .. import config
from ..exits import CliError, LIMITE, SIN_SESION, VALIDACION, code_for_status
from ..httpc import cookie_from_headers, request, request_json
from .common import emit, require_session


def _login_once(url: str, email: str, password: str) -> tuple[str, dict[str, Any]]:
    """Un solo POST /api/auth/login. Nunca reintenta ante 401 o 429."""
    status, headers, raw = request(
        url,
        "POST",
        "/api/auth/login",
        body={"email": email, "password": password},
    )
    parsed: Any = None
    if raw:
        try:
            import json

            parsed = json.loads(raw.decode("utf-8"))
        except Exception:
            parsed = None
    if status == 429:
        message = "Demasiados intentos de inicio de sesión. Intenta más tarde."
        if isinstance(parsed, dict) and parsed.get("message"):
            message = str(parsed["message"])
        raise CliError(message, LIMITE, status=429)
    if status >= 400:
        message = "Usuario o contraseña no válido"
        if isinstance(parsed, dict) and (parsed.get("message") or parsed.get("error")):
            message = str(parsed.get("message") or parsed.get("error"))
        raise CliError(message, code_for_status(status) if status != 401 else SIN_SESION, status=status)
    cookie = cookie_from_headers(headers)
    if not cookie:
        raise CliError("El servidor no devolvió una cookie de sesión.", SIN_SESION, status=status)
    user = parsed.get("user") if isinstance(parsed, dict) else None
    return cookie, user if isinstance(user, dict) else {}


def iniciar_sesion(args) -> int:
    url = (args.url or "").rstrip("/")
    if not url:
        raise CliError("Falta --url (origen de la instancia, p. ej. https://servidor).", VALIDACION)
    usuario = args.usuario or os.environ.get("IMPERIUM_USUARIO") or ""
    if not usuario:
        usuario = input("Usuario (correo): ").strip()
    if not usuario:
        raise CliError("Falta el usuario.", VALIDACION)
    password = args.contrasena or os.environ.get("IMPERIUM_CONTRASENA") or ""
    if not password:
        password = getpass.getpass("Contraseña: ")
    if not password:
        raise CliError("Falta la contraseña.", VALIDACION)
    cookie, user = _login_once(url, usuario, password)
    dispositivo = args.dispositivo or os.environ.get("IMPERIUM_DISPOSITIVO") or os.uname().nodename
    status, _headers, body = request_json(
        url,
        "POST",
        "/api/cli/token/generate",
        cookie=cookie,
        body={"name": dispositivo, "device_name": dispositivo},
    )
    data = body.get("data") if isinstance(body, dict) else None
    row = data[0] if isinstance(data, list) and data else {}
    token = row.get("token") if isinstance(row, dict) else None
    if not token:
        raise CliError("El núcleo no devolvió un token CLI.", SIN_SESION, status=status)
    public_user = {
        "_id": user.get("_id") or user.get("id"),
        "name": user.get("name"),
        "email": user.get("email") or usuario,
    }
    cfg = config.load()
    name = config.profile_name(cfg, args.perfil)
    config.upsert_profile(
        cfg,
        name,
        {
            "url": url,
            "token": token,
            "token_prefix": row.get("token_prefix"),
            "token_id": row.get("id"),
            "user": public_user,
            "device": dispositivo,
        },
        activate=True,
    )
    saved = config.save(cfg)
    return emit(
        {
            "ok": True,
            "perfil": name,
            "url": url,
            "user": public_user,
            "device": dispositivo,
            "token_prefix": row.get("token_prefix"),
            "config": str(saved),
        },
        as_json=args.json,
        text=f"Sesión iniciada como {public_user.get('email')} en {url} (perfil {name}).",
    )


def cerrar_sesion(args) -> int:
    data, name, profile = require_session(args)
    token = profile.get("token")
    url = profile.get("url")
    try:
        request_json(
            url,
            "POST",
            "/api/cli/token/revoke",
            token=token,
            body={"id": profile.get("token_id")} if profile.get("token_id") else {},
        )
    except CliError as err:
        # Si el token ya no vale, igual limpiamos el perfil.
        if err.code not in {SIN_SESION}:
            raise
    profile["token"] = None
    profile["token_id"] = None
    profile["token_prefix"] = None
    config.upsert_profile(data, name, profile, activate=False)
    config.save(data)
    return emit(
        {"ok": True, "perfil": name},
        as_json=args.json,
        text=f"Sesión cerrada en el perfil {name}.",
    )
