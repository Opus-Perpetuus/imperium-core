"""Cliente HTTP mínimo (urllib). Un intento; nunca reintenta solo el login."""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urljoin

from .exits import CliError, RED, code_for_status

CLIENT_HEADER = "imperium-cli"
DEFAULT_TIMEOUT = 30


def join(base: str, path: str) -> str:
    origin = base.rstrip("/") + "/"
    rel = path if path.startswith("/") else "/" + path
    return urljoin(origin, rel[1:] if False else rel)


def request(
    base: str,
    method: str,
    path: str,
    *,
    token: str | None = None,
    cookie: str | None = None,
    body: Any = None,
    timeout: float = DEFAULT_TIMEOUT,
    accept: str = "application/json",
    extra_headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], bytes]:
    url = join(base, path)
    data = None
    headers = {
        "accept": accept,
        "user-agent": f"{CLIENT_HEADER}/{_ua_version()}",
        "x-imperium-client": CLIENT_HEADER,
    }
    if extra_headers:
        headers.update(extra_headers)
    if token:
        headers["authorization"] = f"Bearer {token}"
    if cookie:
        headers["cookie"] = cookie
    if body is not None:
        raw = json.dumps(body).encode("utf-8")
        data = raw
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method.upper(), headers=headers)
    context = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=context) as res:
            payload = res.read()
            return int(res.status), {k.lower(): v for k, v in res.headers.items()}, payload
    except urllib.error.HTTPError as err:
        payload = err.read() if err.fp else b""
        return int(err.code), {k.lower(): v for k, v in err.headers.items()}, payload
    except urllib.error.URLError as err:
        raise CliError(f"No se pudo conectar con {url}: {err.reason}", RED) from err
    except TimeoutError as err:
        raise CliError(f"Se agotó el tiempo de espera de {url}", RED) from err


def request_json(
    base: str,
    method: str,
    path: str,
    **kwargs: Any,
) -> tuple[int, dict[str, str], Any]:
    status, headers, raw = request(base, method, path, **kwargs)
    parsed: Any = None
    if raw:
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            parsed = raw.decode("utf-8", errors="replace")
    if status >= 400:
        message = _message_of(parsed) or f"El servidor respondió {status}"
        raise CliError(message, code_for_status(status), status=status)
    return status, headers, parsed


def _message_of(parsed: Any) -> str:
    if isinstance(parsed, dict):
        for key in ("message", "error", "mensaje"):
            value = parsed.get(key)
            if isinstance(value, str) and value.strip():
                return value
    return ""


def cookie_from_headers(headers: dict[str, str]) -> str:
    # urllib expone set-cookie; si hay varias, las unimos.
    value = headers.get("set-cookie") or headers.get("set-cookie2") or ""
    parts = []
    for chunk in value.split(","):
        first = chunk.split(";", 1)[0].strip()
        if "=" in first:
            parts.append(first)
    # Puede partir cookies mal si hay expires=...; nos quedamos con connect.sid si aparece.
    for part in parts:
        if part.lower().startswith("connect.sid="):
            return part
    return parts[0] if parts else ""


def _ua_version() -> str:
    from .version import cli_version

    return cli_version()
