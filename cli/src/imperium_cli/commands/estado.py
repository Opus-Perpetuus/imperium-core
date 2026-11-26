from __future__ import annotations

from ..exits import CliError, RED
from ..httpc import request, request_json
from ..version import cli_version
from .common import emit, require_profile, require_session


def _health(url: str) -> dict:
    for path in ("/api/health", "/health"):
        status, _headers, raw = request(url, "GET", path)
        if status >= 400:
            continue
        import json

        try:
            parsed = json.loads(raw.decode("utf-8"))
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise CliError(f"No se pudo leer /health en {url}", RED)


def estado(args) -> int:
    data, name, profile = require_profile(args)
    health = _health(profile["url"])
    info: dict = {
        "perfil": name,
        "url": profile["url"],
        "cli": cli_version(),
        "health": health,
    }
    if profile.get("token"):
        try:
            _status, _headers, me = request_json(profile["url"], "GET", "/api/auth/", token=profile["token"])
            info["user"] = me
        except CliError:
            info["user"] = profile.get("user")
            info["sesion"] = "token no válido o caducado"
        try:
            _s, _h, subjects = request_json(profile["url"], "GET", "/api/subjects", token=profile["token"])
            rows = subjects.get("data") if isinstance(subjects, dict) else None
            info["apps"] = len(rows) if isinstance(rows, list) else None
        except CliError as err:
            info["apps_error"] = err.message
    else:
        info["sesion"] = "sin token"
    lines = [
        f"CLI {info['cli']} · perfil {name} · {profile['url']}",
        f"Núcleo {health.get('version', '?')}  boot={health.get('boot')}  db={health.get('db')}  ok={health.get('ok')}",
    ]
    if info.get("user"):
        user = info["user"] if isinstance(info["user"], dict) else {}
        lines.append(f"Usuario {user.get('name') or ''} <{user.get('email') or ''}>")
    if info.get("apps") is not None:
        lines.append(f"Apps visibles: {info['apps']}")
    return emit(info, as_json=args.json, text="\n".join(lines))


def version_cmd(args) -> int:
    url = getattr(args, "url", None)
    payload = {"cli": cli_version()}
    if not url:
        try:
            _data, _name, profile = require_profile(args)
            url = profile["url"]
        except CliError:
            url = None
    if url:
        health = _health(url)
        payload["core"] = health.get("version")
        payload["health"] = health
        payload["url"] = url
    text = f"CLI {payload['cli']}"
    if payload.get("core"):
        text += f" · núcleo {payload['core']}"
    return emit(payload, as_json=args.json, text=text)
