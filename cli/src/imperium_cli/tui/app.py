"""TUI de Imperium con flexablelib: menú dinámico (/api/auth/menus), lista,
detalle y formulario genéricos (/api/meta) y asistente masivo.

Atajos: Ctrl+K paleta, Esc volver, / buscar, f filtros, a alta, F1 ayuda,
F2 editar, F4 detalle, F6 caja, F9 asistente masivo, q salir.
`IMPERIUM_RESTRINGIDO=1` (ssh-shell) quita el asistente masivo. `--accesible`,
`TERM=dumb` o `IMPERIUM_ACCESIBLE` dan la salida lineal; `NO_COLOR` quita color.
"""

from __future__ import annotations

import os
from typing import Any

from flexablelib import App, Card, KeyMap
from flexablelib_components import (
    Alert,
    AppShell,
    CommandPalette,
    DataTable,
    DetailView,
    EmptyState,
    FilterBar,
    Form,
    Sidebar,
    Stack,
    TextInput,
    Wizard,
)
from flexablelib_tui.accessibility import audit

from ..commands.estado import _health
from ..exits import CliError
from ..httpc import request_json
from ..version import cli_version

SHORTCUTS = {
    "ctrl+k": "Paleta de comandos",
    "escape": "Volver",
    "/": "Buscar",
    "f": "Filtros",
    "a": "Alta",
    "f2": "Editar",
    "f4": "Detalle",
    "f6": "Caja",
    "f9": "Asistente masivo",
    "q": "Salir",
}


class Backend:
    """Lecturas del núcleo con el token del perfil. Las pruebas pasan uno falso."""

    def __init__(self, profile: dict[str, Any] | None):
        self.profile = profile or {}
        self.warning: str | None = None

    def _get(self, path: str) -> Any:
        url, token = self.profile.get("url"), self.profile.get("token")
        if not url or not token:
            return None
        try:
            return request_json(url, "GET", path, token=token)[2]
        except CliError as err:
            self.warning = self.warning or err.message
            return None

    def health(self) -> dict[str, Any]:
        if not self.profile.get("url"):
            return {}
        try:
            return _health(self.profile["url"])
        except CliError as err:
            self.warning = err.message
            return {}

    def menus(self) -> list[dict[str, Any]]:
        body = self._get("/api/auth/menus")
        rows = body.get("menus") if isinstance(body, dict) else None
        return [m for m in rows or [] if isinstance(m, dict)]

    def meta(self) -> list[dict[str, Any]]:
        body = self._get("/api/meta")
        out: list[dict[str, Any]] = []
        for row in (body or {}).get("data") or [] if isinstance(body, dict) else []:
            if isinstance(row, dict):
                out.extend(r for r in row.get("resources") or [] if isinstance(r, dict))
        return out

    def rows(self, meta: dict[str, Any], limit: int = 50) -> list[dict[str, Any]]:
        path = "/api/" + str(meta.get("path") or meta.get("resource") or "").strip("/")
        body = self._get(f"{path}?limite={limit}")
        rows = body.get("data") if isinstance(body, dict) else body
        return [r for r in rows or [] if isinstance(r, dict)]


def menu_sections(menus: list[dict[str, Any]], on_open) -> dict[str, list[dict[str, Any]]]:
    """Árbol plano de `/api/auth/menus` → secciones del Sidebar (raíz → hojas)."""
    by_order = sorted(menus, key=lambda m: (float(m.get("order") or 0), str(m.get("name") or "")))
    roots = [m for m in by_order if not m.get("parent_id")]
    sections: dict[str, list[dict[str, Any]]] = {}
    for root in roots:
        kids = [m for m in by_order if str(m.get("parent_id") or "") == str(root.get("_id"))]
        items = [_menu_item(m, on_open) for m in (kids or [root]) if m.get("name")]
        if items:
            sections[str(root.get("name") or "Menú")] = items
    return sections


def _menu_item(menu: dict[str, Any], on_open) -> dict[str, Any]:
    path = str(menu.get("path") or "")
    return {"label": str(menu.get("name")), "action": lambda p=path: on_open(p)}


class ImperiumTui:
    def __init__(self, profile: dict[str, Any] | None, backend: Backend | None = None):
        self.profile = profile
        self.backend = backend or Backend(profile)
        self.metas = self.backend.meta()
        self.current: dict[str, Any] | None = self.metas[0] if self.metas else None
        self.app: App | None = None
        self.health = self.backend.health()
        self._build()

    # ----- pantallas
    def _build(self) -> None:
        self.estado = self._estado_card()
        self.sidebar = Sidebar(menu_sections(self.backend.menus(), self.open_path) or {"Imperium": [{"label": "Estado", "action": lambda: self.show("Estado")}]}, title="Menú", a11y_label="Menú")
        self.table, self.filter = self._list_for(self.current)
        self.detail = DetailView(self._detail_fields(None), a11y_label="Detalle")
        self.form = self._form_for(self.current)
        self.restringido = bool(os.environ.get("IMPERIUM_RESTRINGIDO"))
        self.wizard = None if self.restringido else self._wizard()
        self.caja_input = TextInput(label="Código de barras", name="codigo", a11y_label="Código de barras")
        self.caja = Stack([self._caja_card(), self.caja_input], a11y_label="Caja")
        lista = Stack([self.filter, self.table]) if self.filter else self.table
        pages = {"Estado": self.estado, "Lista": lista, "Detalle": self.detail, "Formulario": self.form, "Caja": self.caja}
        if self.wizard is not None:
            pages["Masivo"] = self.wizard
        self.shell = AppShell(
            sidebar=self.sidebar,
            pages=pages,
            content=self.estado,
            a11y_label="Imperium",
        )
        commands = [{"label": f"Abrir {m.get('name') or m['resource']}", "action": (lambda mm=m: self.open_meta(mm)), "keywords": [m["resource"]]} for m in self.metas]
        commands += [{"label": label, "action": (lambda k=key: self.show(k))} for label, key in (("Estado", "Estado"), ("Caja", "Caja"), ("Asistente masivo", "Masivo")) if key in pages]
        self.palette = CommandPalette(commands, title="Comandos", a11y_label="Paleta de comandos")
        self.alert = Alert(self.backend.warning, kind="warning") if self.backend.warning else None

    def _estado_card(self) -> Card:
        h, prof = self.health, self.profile or {}
        return Card(
            title="Estado de Imperium",
            fields={
                "CLI": cli_version(),
                "Núcleo": str(h.get("version") or "—"),
                "Base de datos": "ok" if h.get("db") else "caída" if h else "—",
                "Usuario": (prof.get("user") or {}).get("email") or "sin sesión",
                "Origen": prof.get("url") or "—",
                "Recursos": str(len(self.metas)),
            },
        )

    def _caja_card(self) -> Card:
        return Card(
            title="Caja",
            fields={
                "Lector": "Escanea: cada código se agrega al carrito",
                "Cantidad": "3*código",
                "Cobrar": "imperium pos caja --pago efectivo --efectivo 500",
                "Sesión": "la abierta, o --sesion <id>",
            },
        )

    def _list_for(self, meta: dict[str, Any] | None):
        if not meta:
            return EmptyState(title="Sin recursos visibles, o sin sesión.", a11y_label="Lista"), None
        cols = [c["name"] for c in meta.get("list_columns") or [] if isinstance(c, dict)][:6] or ["_id", "name"]
        rows = [{c: _cell(r.get(c)) for c in cols} for r in self.backend.rows(meta)]
        table = DataTable(columns=cols, rows=rows, selectable=True, page_size=20, empty="Sin registros", a11y_label=f"Lista de {meta.get('name') or meta['resource']}")
        return table, FilterBar(table=table, label="Filtro", a11y_label="Filtro")

    def _detail_fields(self, row: dict[str, Any] | None) -> list[tuple[str, str]]:
        if not row:
            return [("Registro", "Elige una fila y pulsa F4")]
        return [(str(k), _cell(v)) for k, v in row.items()]

    def _form_for(self, meta: dict[str, Any] | None):
        fields = [f for f in (meta or {}).get("fields") or [] if isinstance(f, dict) and f.get("name")]
        if not fields:
            return EmptyState(title="Sin formulario para este recurso.", a11y_label="Formulario")
        inputs = [TextInput(label=(f.get("label") or f["name"]) + (" *" if f.get("required") else ""), name=f["name"]) for f in fields[:24]]
        return Form(inputs, title=f"Alta de {meta.get('name') or meta['resource']}", a11y_label="Formulario")

    def _wizard(self) -> Wizard:
        steps = [
            ("Archivo", TextInput(label="Archivo CSV o XLSX", name="archivo", a11y_label="Archivo")),
            ("Mapeo", Card(title="Mapeo de columnas", fields={"Recurso": (self.current or {}).get("resource") or "—", "Columnas": "columna=campo"})),
            ("Dry-run", Card(title="Plan", fields={"Comando": "imperium masivo importar <recurso> --desde archivo"})),
            ("Confirmar", Card(title="Confirmar", fields={"Ejecutar": "--yes (borrar hace respaldo previo)"})),
            ("Reporte", Card(title="Reporte", fields={"CSV": "masivo-<id>-reporte.csv"})),
        ]
        return Wizard(steps, a11y_label="Asistente masivo")

    # ----- navegación
    def show(self, page: str) -> None:
        self.shell.open_page(page)

    def open_meta(self, meta: dict[str, Any]) -> None:
        self.current = meta
        self.table, self.filter = self._list_for(meta)
        self.form = self._form_for(meta)
        self.shell.pages["Lista"] = Stack([self.filter, self.table]) if self.filter else self.table
        self.shell.pages["Formulario"] = self.form
        self.show("Lista")

    def open_path(self, path: str) -> None:
        wanted = path.strip("/").split("/")[-1] if path else ""
        for meta in self.metas:
            if wanted and wanted in (str(meta.get("path") or "").strip("/"), meta.get("resource")):
                return self.open_meta(meta)
        self.show("Estado")

    def detail_selected(self) -> None:
        rows = getattr(self.table, "rows", None) or []
        index = getattr(self.table, "index", 0) or 0
        row = rows[index] if isinstance(rows, list) and 0 <= index < len(rows) else None
        self.detail = DetailView(self._detail_fields(row if isinstance(row, dict) else None), a11y_label="Detalle")
        self.shell.pages["Detalle"] = self.detail
        self.show("Detalle")

    def focus_filter(self) -> None:
        self.show("Lista")
        if self.filter is not None and self.app is not None:
            self.app.focus(self.filter)

    def components(self) -> list[Any]:
        return [c for c in (self.shell, self.sidebar, self.table, self.filter, self.detail, self.form, self.wizard, self.caja, self.caja_input, self.palette) if c is not None]

    def typing(self) -> bool:
        """True si el foco está en un campo de texto (o dentro de un Form/FilterBar/Wizard)."""
        node = getattr(self.app, "focused", None)
        seen: set[int] = set()
        while node is not None and id(node) not in seen:
            seen.add(id(node))
            if isinstance(node, (TextInput, Form, FilterBar, Wizard)):
                return True
            node = getattr(node, "parent", None)
        return False

    def _letter(self, action):
        def run():
            if self.typing():
                return False
            return action()

        return run

    def bindings(self) -> dict[str, Any]:
        out = {
            "ctrl+k": (lambda: self.palette.open(self.app), SHORTCUTS["ctrl+k"]),
            "escape": (lambda: self.show("Estado"), SHORTCUTS["escape"]),
            "/": (self._letter(self.focus_filter), SHORTCUTS["/"]),
            "f": (self._letter(self.focus_filter), SHORTCUTS["f"]),
            "a": (self._letter(lambda: self.show("Formulario")), SHORTCUTS["a"]),
            "f2": (lambda: self.show("Formulario"), SHORTCUTS["f2"]),
            "f4": (self.detail_selected, SHORTCUTS["f4"]),
            "f6": (self.open_caja, SHORTCUTS["f6"]),
        }
        if self.wizard is not None:
            out["f9"] = (lambda: self.show("Masivo"), SHORTCUTS["f9"])
        return out

    def open_caja(self) -> None:
        self.show("Caja")
        if self.app is not None:
            self.app.focus(self.caja_input)


def _cell(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("name") or value.get("codigo") or value.get("_id") or "")
    return "" if value is None else str(value)


def run_tui(*, profile: dict[str, Any] | None, accesible: bool = False, keys: list[str] | None = None, backend: Backend | None = None):
    use_colors = None if os.environ.get("NO_COLOR") is None else False
    screen_reader = bool(accesible or os.environ.get("TERM") == "dumb" or os.environ.get("IMPERIUM_ACCESIBLE"))
    tui = ImperiumTui(profile, backend)
    app = App(body=tui.shell, title="Imperium", keymap=KeyMap(), screen_reader=screen_reader, use_colors=use_colors, bindings=tui.bindings())
    tui.app = app
    app.bindings["q"] = tui._letter(app.exit)
    if keys is not None:
        return app.run(keys=keys)
    app.run()
    return None


def audit_shell(profile: dict[str, Any] | None = None, backend: Backend | None = None):
    """Puerta de accesibilidad: lista vacía si las pantallas cumplen el contrato."""
    return audit(ImperiumTui(profile, backend).components(), check_focus=True)
