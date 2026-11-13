"""TUI de Imperium con flexablelib 3.5: App, AppShell, DataTable, Card, audit."""

from __future__ import annotations

import os
from typing import Any

from flexablelib import App, Card, KeyMap
from flexablelib_components import Alert, AppShell, DataTable, EmptyState
from flexablelib_tui.accessibility import audit

from ..commands.estado import _health
from ..exits import CliError
from ..httpc import request_json
from ..version import cli_version


def run_tui(*, profile: dict[str, Any] | None, accesible: bool = False, keys: list[str] | None = None):
    use_colors = None if os.environ.get("NO_COLOR") is None else False
    screen_reader = bool(accesible or os.environ.get("TERM") == "dumb" or os.environ.get("IMPERIUM_ACCESIBLE"))
    estado_card, apps_table, backups_table, users_table, alert = _pages(profile)

    shell = AppShell(
        pages={
            "Estado": estado_card,
            "Apps": apps_table,
            "Respaldos": backups_table,
            "Usuarios": users_table,
        },
        content=estado_card,
        a11y_label="Imperium",
    )
    keymap = KeyMap()
    app = App(
        body=shell,
        title="Imperium",
        keymap=keymap,
        screen_reader=screen_reader,
        use_colors=use_colors,
        bindings={
            "/": (_noop, "Buscar"),
        },
    )
    app.bindings["q"] = app.quit
    if keys is not None:
        return app.run(keys=keys)
    app.run()
    return None


def audit_shell(profile: dict[str, Any] | None = None):
    """Puerta de accesibilidad: lista vacía si las pantallas cumplen el contrato."""
    estado_card, apps_table, backups_table, users_table, _alert = _pages(profile)
    shell = AppShell(
        pages={"Estado": estado_card, "Apps": apps_table, "Respaldos": backups_table, "Usuarios": users_table},
        content=estado_card,
        a11y_label="Imperium",
    )
    return audit([shell, apps_table, backups_table, users_table], check_focus=True)


def _pages(profile: dict[str, Any] | None):
    health: dict[str, Any] = {}
    user: dict[str, Any] = {}
    apps: list[dict[str, Any]] = []
    backups: list[dict[str, Any]] = []
    users: list[dict[str, Any]] = []
    warning = None
    if profile and profile.get("url"):
        try:
            health = _health(profile["url"])
        except CliError as err:
            warning = err.message
        token = profile.get("token")
        if token:
            user, apps, backups, users, warning = _load_lists(profile["url"], token, warning)

    fields = {
        "CLI": cli_version(),
        "Núcleo": str(health.get("version") or "—"),
        "Base de datos": "ok" if health.get("db") else "caída" if health else "—",
        "Arranque": str(health.get("boot") or "—"),
        "Usuario": (user.get("email") or (profile or {}).get("user", {}).get("email") or "sin sesión"),
        "Origen": (profile or {}).get("url") or "—",
    }
    estado_card = Card(title="Estado de Imperium", fields=fields)
    apps_table = _table_or_empty(
        ["slug", "name", "estado"],
        _rows(apps, ["slug", "name", "technical_id", "installed"]),
        "Sin apps visibles.",
        "Apps",
    )
    backups_table = _table_or_empty(
        ["id", "fecha"],
        _backup_rows(backups),
        "Sin respaldos, o sin permiso para verlos.",
        "Respaldos",
    )
    users_table = _table_or_empty(
        ["nombre", "correo"],
        _user_rows(users),
        "Sin usuarios, o sin permiso para verlos.",
        "Usuarios",
    )
    alert = Alert(warning, kind="warning") if warning else None
    return estado_card, apps_table, backups_table, users_table, alert


def _load_lists(url: str, token: str, warning: str | None):
    user: dict[str, Any] = {}
    apps: list[dict[str, Any]] = []
    backups: list[dict[str, Any]] = []
    users: list[dict[str, Any]] = []
    try:
        _s, _h, me = request_json(url, "GET", "/api/auth/", token=token)
        if isinstance(me, dict):
            user = me
    except CliError as err:
        warning = warning or err.message
    try:
        _s, _h, body = request_json(url, "GET", "/api/subjects", token=token)
        rows = body.get("data") if isinstance(body, dict) else body
        if isinstance(rows, list):
            apps = [r for r in rows if isinstance(r, dict)]
    except CliError as err:
        warning = warning or err.message
    try:
        _s, _h, body = request_json(url, "GET", "/api/db-admin/backups", token=token)
        rows = body.get("data") if isinstance(body, dict) else body
        if isinstance(rows, list):
            backups = [r for r in rows if isinstance(r, dict)]
    except CliError:
        pass
    try:
        _s, _h, body = request_json(url, "GET", "/api/user", token=token)
        rows = body.get("data") if isinstance(body, dict) else body
        if isinstance(rows, list):
            users = [r for r in rows if isinstance(r, dict)]
    except CliError:
        pass
    return user, apps, backups, users, warning



def _table_or_empty(columns, rows, empty: str, label: str):
    if not rows:
        return EmptyState(title=empty, a11y_label=label)
    return DataTable(columns=columns, rows=rows, selectable=True, empty=empty, a11y_label=label)


def _rows(items: list[dict[str, Any]], keys: list[str]) -> list[dict[str, Any]]:
    out = []
    for item in items:
        slug = item.get("slug") or str(item.get("technical_id") or "").removeprefix("subject-")
        out.append(
            {
                "slug": slug,
                "name": item.get("name") or slug,
                "estado": "instalada" if item.get("installed") or item.get("is_installed") else "catálogo",
            }
        )
    return out


def _backup_rows(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"id": item.get("id") or item.get("name"), "fecha": item.get("created_at") or item.get("label") or ""} for item in items]


def _user_rows(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"nombre": item.get("name") or "", "correo": item.get("email") or ""} for item in items]


def _noop() -> None:
    return None
