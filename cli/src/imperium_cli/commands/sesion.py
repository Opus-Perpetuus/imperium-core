from __future__ import annotations

import getpass
import json
import os
import sys
import time
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


DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
_sleep = time.sleep
_now = time.monotonic


def _wants_device(args) -> bool:
    if getattr(args, "codigo_dispositivo", False):
        return True
    if args.usuario or args.contrasena or os.environ.get("IMPERIUM_USUARIO") or os.environ.get("IMPERIUM_CONTRASENA"):
        return False
    if not sys.stdin.isatty():
        raise CliError("Sin terminal interactiva: usa --codigo-dispositivo o --usuario/--contrasena.", VALIDACION)
    sys.stderr.write("¿Cómo quieres iniciar sesión?\n  1) Código de dispositivo (recomendado)\n  2) Usuario y contraseña\n")
    answer = input("Opción [1]: ").strip()
    return answer in ("", "1")


def _device_login(url: str, dispositivo: str) -> tuple[str, dict[str, Any], dict[str, Any]]:
    """RFC 8628: pide el código, lo muestra en stderr y pregunta sin reintentar el login."""
    _s, _h, code = request_json(url, "POST", "/api/cli/device/code", body={"device_name": dispositivo})
    if not isinstance(code, dict) or not code.get("device_code"):
        raise CliError("El núcleo no devolvió un código de dispositivo.", SIN_SESION)
    verify = url + str(code.get("verification_path") or "/api/cli/device")
    sys.stderr.write(
        f"Abre {verify}?user_code={code['user_code']} con tu sesión de Imperium\n"
        f"y aprueba el código: {code['user_code']}\n"
    )
    sys.stderr.flush()
    interval = max(1, int(code.get("interval") or 5))
    deadline = _now() + int(code.get("expires_in") or 600)
    while True:
        _sleep(interval)
        if _now() > deadline:
            raise CliError("El código de dispositivo expiró. Corre de nuevo imperium iniciar-sesion.", SIN_SESION)
        status, _h, raw = request(
            url,
            "POST",
            "/api/cli/device/token",
            body={"grant_type": DEVICE_GRANT_TYPE, "device_code": code["device_code"]},
        )
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            body = {}
        if status == 200 and isinstance(body, dict) and body.get("access_token"):
            row = {"token": body["access_token"], "token_prefix": body.get("token_prefix"), "id": body.get("id")}
            return body["access_token"], row, body.get("user") or {}
        error = body.get("error") if isinstance(body, dict) else None
        if error == "authorization_pending":
            continue
        if error == "slow_down":
            interval = max(interval + 5, int(body.get("interval") or 0))
            continue
        if status == 429:
            raise CliError("Demasiadas solicitudes al núcleo. Intenta más tarde.", LIMITE, status=429)
        if error == "access_denied":
            raise CliError("La solicitud se rechazó en el navegador.", SIN_SESION, status=status)
        if error == "expired_token":
            raise CliError("El código de dispositivo expiró. Corre de nuevo imperium iniciar-sesion.", SIN_SESION, status=status)
        message = (body.get("message") if isinstance(body, dict) else None) or f"El núcleo respondió {status}"
        raise CliError(str(message), SIN_SESION if status < 500 else code_for_status(status), status=status)


def iniciar_sesion(args) -> int:
    url = (args.url or "").rstrip("/")
    if not url:
        raise CliError("Falta --url (origen de la instancia, p. ej. https://servidor).", VALIDACION)
    dispositivo = args.dispositivo or os.environ.get("IMPERIUM_DISPOSITIVO") or os.uname().nodename
    if _wants_device(args):
        token, row, user = _device_login(url, dispositivo)
        usuario = str(user.get("email") or "")
    else:
        token, row, user, usuario = _password_login(args, url, dispositivo)
    return _save_login(args, url, dispositivo, token, row, user, usuario)


def _password_login(args, url: str, dispositivo: str):
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
    return token, row, user, usuario


def _save_login(args, url, dispositivo, token, row, user, usuario) -> int:
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
