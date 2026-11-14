"""TUI de Imperium con flexablelib.

* Barra lateral: solo las apps (raíces de `/api/auth/menus`). Enter abre la
  app y enseña su árbol de submenús, plegable a cualquier profundidad.
* Cada hoja se abre como la GUI: una pantalla de app (`nox.*`, p. ej. «Ver
  tabla» de Herramientas), un CRUD de app (`feature-shell`) o el CRUD del
  núcleo (`/api/meta`). Toda tabla es `ViewList` (búsqueda, paginación,
  orden, detalle con imágenes).
* Formularios con todos los tipos de entrada de flexablelib (ver `fields.py`).
* Imágenes con el mejor método de la terminal (ver `media.py`).

Teclas (F1 las lista; la barra de abajo enseña las principales): ver
`SHORTCUTS`. `IMPERIUM_RESTRINGIDO=1` (ssh-shell) quita el asistente masivo y
las escrituras; `--accesible`, `TERM=dumb` o `IMPERIUM_ACCESIBLE` dan la
salida lineal; `NO_COLOR` quita color.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import parse_qsl, quote, urlencode, urlparse

from flexablelib import App, Card, KeyMap
from flexablelib._images import read_source
from flexablelib_components import (
    Image,
    ImageViewer,
    Alert,
    AppShell,
    Breadcrumbs,
    CommandPalette,
    ConfirmDialog,
    DataTable,
    DetailView,
    EmptyState,
    FileInput,
    FilterBar,
    Form,
    HelpLine,
    Sidebar,
    Stack,
    TopBar,
    Tree,
    Wizard,
    ScanInput,
    VStack,
)
from flexablelib_components.base import Input
from flexablelib_tui import KeyHints
from flexablelib_tui.accessibility import audit

from ..commands.estado import _health
from ..exits import CliError
from ..httpc import join, request_json
from ..version import cli_version
from . import media
from .fields import form_payload, meta_input
from .menu import MenuNode, build_tree, sidebar_items, trail_for, tree_data
from .nox import NoxRenderer, Rendered, _jsonable, page_id_and_query
from .layout import ContentScroll, child_nodes, grid_form, walk
from .views import Column, ListTable, ViewList, cell, detail

SHORTCUTS = {
    "ctrl+k": "Paleta (abre cualquier pantalla)",
    "escape": "Volver",
    "backspace": "Volver",
    "alt+left": "Volver",
    "m": "Ir al menú de apps",
    "h": "Inicio",
    "/": "Buscar",
    "f": "Filtros",
    "n": "Página siguiente",
    "p": "Página anterior",
    "r": "Recargar",
    "f5": "Recargar",
    "a": "Alta",
    "f2": "Editar el registro elegido",
    "f4": "Detalle",
    "i": "Imágenes del registro",
    "f6": "Caja",
    "f9": "Asistente masivo",
    "q": "Salir",
}
FOOTER = [("F1", "Ayuda"), ("Ctrl+K", "Paleta"), ("m", "Apps"), ("Esc", "Volver"), ("/", "Buscar"), ("n/p", "Página"), ("i", "Imágenes"), ("q", "Salir")]
IMAGE_MAX_BYTES = 8 * 1024 * 1024


class Backend:
    """Lecturas y escrituras con el token del perfil. Las pruebas pasan uno falso."""

    def __init__(self, profile: dict[str, Any] | None):
        self.profile = profile or {}
        self.warning: str | None = None
        self._pages: dict[str, list[dict[str, Any]]] = {}
        self._leaves: list[dict[str, Any]] | None = None
        self._options: dict[str, list[dict[str, Any]]] = {}

    # ----- http
    def _get(self, path: str, *, quiet: bool = False) -> Any:
        url, token = self.profile.get("url"), self.profile.get("token")
        if not url or not token:
            return None
        try:
            return request_json(url, "GET", path, token=token)[2]
        except CliError as err:
            if not quiet:
                self.warning = self.warning or err.message
            return None

    def write(self, method: str, path: str, body: dict[str, Any]) -> str:
        url, token = self.profile.get("url"), self.profile.get("token")
        if not url or not token:
            raise CliError("Sin sesión: corre «imperium iniciar-sesion».")
        _s, _h, parsed = request_json(url, method, path, token=token, body=body)
        return str((parsed or {}).get("message") or "Listo.") if isinstance(parsed, dict) else "Listo."

    def image_request(self, src: str) -> tuple[str, dict[str, str]] | None:
        """URL absoluta de una imagen y sus headers: el token solo va al mismo
        origen del perfil (las de otro origen, o `//cdn…`, van sin él)."""
        url, token = self.profile.get("url"), self.profile.get("token")
        if src.startswith("api://"):
            src = "/api/" + src[len("api://") :].lstrip("/")
        if src.startswith(("http://", "https://")):
            final = src
        elif url:
            final = join(url, src)
        else:
            return None
        parsed, mine = urlparse(final), urlparse(url or "")
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return None
        same = bool(url) and (parsed.scheme, parsed.netloc) == (mine.scheme, mine.netloc)
        headers = {"Accept": "image/*,*/*;q=0.5", "X-Imperium-Client": "imperium-cli"}
        if same and token:
            headers["Authorization"] = f"Bearer {token}"
        return final, headers

    def fetch_bytes(self, src: str) -> bytes | None:
        """Baja una imagen con `read_source(headers=)` de flexablelib: el
        `Authorization` no se reenvía si el servidor redirige a otro lado."""
        target = self.image_request(src)
        if target is None:
            return None
        try:
            raw, _name = read_source(target[0], timeout=10, max_bytes=IMAGE_MAX_BYTES, headers=target[1])
        except Exception:  # noqa: BLE001 - ImageError/OSError: la imagen se queda en su texto
            return None
        return raw or None

    # ----- lecturas
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

    def list_page(self, meta: dict[str, Any], page: int = 1, size: int = 20, term: str = "") -> tuple[list[dict[str, Any]], int | None]:
        if type(self).rows is not Backend.rows:  # backend viejo (pruebas) que solo sabe `rows`
            rows = self.rows(meta, limit=size)
            return rows, len(rows)
        path = "/api/" + str(meta.get("path") or meta.get("resource") or "").strip("/")
        return self.list_source(path, page, size, term)

    def list_source(self, path: str, page: int = 1, size: int = 20, term: str = "") -> tuple[list[dict[str, Any]], int | None]:
        params = {"desde": (max(1, page) - 1) * size, "limite": size}
        if term:
            params["termino"] = term
        sep = "&" if "?" in path else "?"
        body = self._get(f"{path}{sep}{urlencode(params)}")
        rows = body.get("data") if isinstance(body, dict) else body
        total = body.get("total_elementos") if isinstance(body, dict) else None
        rows = [r for r in rows or [] if isinstance(r, dict)] if isinstance(rows, list) else []
        return rows, int(total) if isinstance(total, (int, float)) else None

    def rows(self, meta: dict[str, Any], limit: int = 50) -> list[dict[str, Any]]:
        return self.list_page(meta, 1, limit)[0]

    def registry_leaves(self) -> list[dict[str, Any]]:
        """Hojas que publican las apps (`/api/registry/bootstrap`); [] si no está."""
        if self._leaves is None:
            body = self._get("/api/registry/bootstrap", quiet=True)
            leaves = body.get("leaves") if isinstance(body, dict) else None
            self._leaves = [l for l in leaves or [] if isinstance(l, dict)]
        return self._leaves

    def subject_pages(self, slug: str) -> list[dict[str, Any]]:
        if slug not in self._pages:
            body = self._get(f"/api/m/subject-{quote(slug)}/pages", quiet=True)
            rows = body.get("data") if isinstance(body, dict) else None
            self._pages[slug] = [p for p in rows or [] if isinstance(p, dict)]
        return self._pages[slug]

    def page(self, slug: str, page_id: str, query: str = "") -> dict[str, Any] | None:
        path = f"/api/m/subject-{quote(slug)}/pages/{quote(page_id)}" + (f"?{query}" if query else "")
        body = self._get(path)
        return body if isinstance(body, dict) else None

    def options(self, ref: str) -> list[dict[str, Any]]:
        if ref not in self._options:
            rows, _ = self.list_source("/api/" + ref.strip("/"), 1, 200)
            self._options[ref] = [{"value": r.get("_id") or r.get("id"), "label": cell(r)} for r in rows]
        return self._options[ref]


@dataclass
class View:
    name: str
    title: str
    component: Any
    trail: list[str] = field(default_factory=list)
    lists: list[ViewList] = field(default_factory=list)
    search: Any = None
    paginator: Any = None
    images: list[tuple[str, str]] = field(default_factory=list)
    reload: Callable[[], "View"] | None = None
    meta: dict[str, Any] | None = None
    page: tuple[str, str, str] | None = None  # (slug, page_id, query)
    unsupported: set[str] = field(default_factory=set)


def menu_sections(menus: list[dict[str, Any]], on_open) -> dict[str, list[dict[str, Any]]]:
    """Compatibilidad: secciones raíz → hojas (la TUI ya usa `menu.build_tree`)."""
    sections: dict[str, list[dict[str, Any]]] = {}
    for root in build_tree(menus):
        leaves = [node for _trail, node in root.leaves()] or ([root] if root.path else [])
        items = [{"label": n.name, "action": (lambda p=n.path: on_open(p))} for n in leaves if n is not root or not root.children]
        if items:
            sections[root.name] = items
    return sections


class ImperiumTui:
    def __init__(self, profile: dict[str, Any] | None, backend: Backend | None = None):
        self.profile = profile
        self.backend = backend or Backend(profile)
        self.metas = self.backend.meta()
        self.current: dict[str, Any] | None = self.metas[0] if self.metas else None
        self.app: App | None = None
        self.health = self.backend.health()
        self.roots = build_tree(self.backend.menus())
        self.restringido = bool(os.environ.get("IMPERIUM_RESTRINGIDO"))
        self.history: list[View] = []
        self.view: View | None = None
        self.unsupported: set[str] = set()
        self._build()

    # ----- armado
    def _build(self) -> None:
        self.estado = self._estado_card()
        items = sidebar_items(self.roots, self.open_app)
        items += ["-", {"label": "Estado", "action": lambda: self.go_home()}, {"label": "Caja", "action": self.open_caja}]
        self.sidebar = Sidebar({"Apps": items} if self.roots else {"Imperium": items[1:]}, title="Menú", a11y_label="Apps")
        self.sidebar.hint = "Enter abre la app · ↑↓ mueven · PgUp/PgDn saltan · Ctrl+B oculta la barra"  # type: ignore[attr-defined]
        self.list_view = self._meta_list(self.current)
        self.table = self.list_view.table if self.list_view else None
        self.filter = self.list_view.filter if self.list_view else None
        self.detail = DetailView([("Registro", "Elige una fila y pulsa Enter o F4")], a11y_label="Detalle")
        self.form = self._form_for(self.current, lazy=True)
        self.wizard = None if self.restringido else self._wizard()
        self.caja_input = ScanInput(label="Código de barras", name="codigo", keep_value=False, a11y_label="Código de barras")
        self.caja = Stack([self._caja_card(), self.caja_input], a11y_label="Caja")
        self.app_menu: Tree | None = None
        self.topbar = TopBar(title="Imperium", breadcrumbs=["Inicio"], a11y_label="Ubicación")
        lista = self.list_view.component if self.list_view else EmptyState(title="Sin recursos visibles, o sin sesión.", a11y_label="Lista")
        pages = {"Estado": self.estado, "Lista": lista, "Detalle": self.detail, "Formulario": self.form, "Caja": self.caja}
        if self.wizard is not None:
            pages["Masivo"] = self.wizard
        framed = {name: self._frame(comp) for name, comp in pages.items()}
        self.shell = AppShell(sidebar=self.sidebar, topbar=self.topbar, pages=framed, content=framed["Estado"], a11y_label="Imperium")
        self.palette = CommandPalette(self._commands(pages), title="Comandos", a11y_label="Paleta de comandos")
        self.alert = Alert(self.backend.warning, kind="warning") if self.backend.warning else None
        self.view = View("Estado", "Inicio", self.estado, ["Inicio"])

    def _commands(self, pages: dict[str, Any]) -> list[dict[str, Any]]:
        commands: list[dict[str, Any]] = []
        for root in self.roots:
            commands.append({"label": f"App: {root.name}", "action": (lambda r=root: self.open_app(r)), "keywords": [root.name]})
            for trail, node in root.leaves():
                commands.append({"label": " › ".join(trail), "action": (lambda n=node, t=trail: self.open_path(n.path, list(t))), "keywords": [node.path]})
        known = {c.get("keywords", [""])[0] for c in commands}
        for meta in self.metas:
            if str(meta.get("path") or "") not in known:
                commands.append({"label": f"Abrir {meta.get('name') or meta['resource']}", "action": (lambda mm=meta: self.open_meta(mm)), "keywords": [meta["resource"]]})
        commands += [{"label": label, "action": (lambda k=key: self.show(k))} for label, key in (("Estado", "Estado"), ("Caja", "Caja"), ("Asistente masivo", "Masivo")) if key in pages]
        return commands

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
                "Apps": str(len(self.roots)),
                "Recursos": str(len(self.metas)),
                "Empezar": "m o Tab: apps · Ctrl+K: buscar pantalla · F1: teclas",
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

    def _meta_list(self, meta: dict[str, Any] | None) -> ViewList | None:
        if not meta:
            return None
        cols = [Column(c["name"], c.get("label") or c["name"], image=bool(media.IMAGE_KEYS.search(c["name"]))) for c in meta.get("list_columns") or [] if isinstance(c, dict) and c.get("name")][:8]
        if not cols:
            cols = [Column("_id", "Id"), Column("name", "Nombre")]
        title = str(meta.get("name") or meta["resource"])
        labels = {f["name"]: f.get("label") or f["name"] for f in meta.get("fields") or [] if isinstance(f, dict) and f.get("name")}
        labels.update({c.key: c.label for c in cols})
        view = ViewList(title, cols, fetch=lambda page, size, term, m=meta: self.backend.list_page(m, page, size, term), on_open=lambda row, l=labels: self.open_row(row, l))
        view.labels = labels  # type: ignore[attr-defined]
        return view

    def _form_for(self, meta: dict[str, Any] | None, row: dict[str, Any] | None = None, *, lazy: bool = False):
        fields = [f for f in (meta or {}).get("fields") or [] if isinstance(f, dict) and f.get("name")]
        if not fields:
            return EmptyState(title="Sin formulario para este recurso.", a11y_label="Formulario")
        loader = None if lazy else self.backend.options
        inputs = [meta_input(f, value=(row or {}).get(f["name"]), options_loader=loader) for f in fields]
        inputs = [i for i in inputs if i is not None]
        name = meta.get("name") or meta["resource"]
        title = f"Editar {name}" if row else f"Alta de {name}"
        form = grid_form(inputs, title=title, on_submit=lambda values, m=meta, r=row: self._save(m, form_payload(self.form, values), r), on_cancel=self.back, a11y_label="Formulario")
        form.hint = "Tab/Shift+Tab cambian de campo · Ctrl+S guarda · Esc cancela"  # type: ignore[attr-defined]
        return form

    def _save(self, meta: dict[str, Any], values: dict[str, Any], row: dict[str, Any] | None) -> None:
        from ..commands.recurso import base_path, coerce

        if self.restringido:
            return self.notify("Sesión restringida: sin escrituras.", "warning")
        payload = {k: _jsonable(v) for k, v in values.items() if not (row and v in (None, "") and row.get(k) in (None, ""))}
        try:
            body = coerce(meta, payload, creating=row is None)
            if row:
                rid = str(row.get("_id") or row.get("id") or "")
                message = self.backend.write("PATCH", f"{base_path(meta)}/{quote(rid, safe='')}", body)
            else:
                message = self.backend.write("POST", base_path(meta), body)
        except CliError as err:
            return self.notify(err.message, "error")
        self.notify(message, "success")
        self.open_meta(meta)

    def _wizard(self) -> Wizard:
        steps = [
            ("Archivo", FileInput(label="Archivo CSV o XLSX", name="archivo", extensions=(".csv", ".xlsx"), a11y_label="Archivo")),
            ("Mapeo", Card(title="Mapeo de columnas", fields={"Recurso": (self.current or {}).get("resource") or "—", "Columnas": "columna=campo"})),
            ("Dry-run", Card(title="Plan", fields={"Comando": "imperium masivo importar <recurso> --desde archivo"})),
            ("Confirmar", Card(title="Confirmar", fields={"Ejecutar": "--yes (borrar hace respaldo previo)"})),
            ("Reporte", Card(title="Reporte", fields={"CSV": "masivo-<id>-reporte.csv"})),
        ]
        return Wizard(steps, a11y_label="Asistente masivo")

    @staticmethod
    def _frame(component: Any) -> Any:
        """Toda pantalla se desplaza y sigue al foco. Una lista (o una página
        con tabla) ya es un `VStack` que lo hace y deja que la tabla llene el
        alto; el árbol de una app y el visor de imágenes se desplazan solos a su
        alto; lo demás va en un `ContentScroll` (ScrollView de flexablelib)."""
        if component is None or isinstance(component, (ContentScroll, Tree, ImageViewer, Image)):
            return component
        if isinstance(component, VStack) and any(isinstance(n, ListTable) for n in walk(component)):
            return component
        frame = getattr(component, "_imperium_frame", None)
        if frame is None:
            frame = ContentScroll(component, a11y_label=getattr(component, "a11y_label", None) or "Contenido")
            try:
                component._imperium_frame = frame
            except AttributeError:
                pass
        return frame

    # ----- navegación
    def show(self, page: str) -> None:
        self.shell.open_page(page)
        self.topbar.breadcrumbs = ["Inicio"] if page == "Estado" else (self.view.trail if self.view and self.view.name == page else [page])

    def _present(self, view: View, *, push: bool = True, focus: Any = None) -> None:
        if push and self.view is not None and self.view.component is not view.component:
            self.history.append(self.view)
            del self.history[:-50]
        self.view = view
        self.unsupported |= view.unsupported
        self.shell.pages[view.name] = self._frame(view.component)
        self.shell.open_page(view.name)
        self.topbar.breadcrumbs = view.trail or [view.title]
        for lst in view.lists:
            lst.table.on_search_key = self.focus_filter
        if self.app is not None:
            target = focus or self._first_focus(view)
            if target is not None:
                self.app.focus(target)
            announce = getattr(self.app, "announce", None)
            if announce is not None:
                announce(" › ".join(view.trail or [view.title]))

    def _first_focus(self, view: View) -> Any:
        if view.lists:
            return view.lists[0].table
        if isinstance(view.component, Tree):
            return view.component
        if self.app is None:
            return None
        for comp in self.app.walk(view.component) if hasattr(self.app, "walk") else []:
            if getattr(comp, "focusable", False):
                return comp
        # Sin nada enfocable (una ficha, un texto): el foco va al scroll para
        # que las flechas y PgUp/PgDn lo recorran.
        frame = self._frame(view.component)
        return frame if isinstance(frame, ContentScroll) else None

    def back(self) -> bool:
        if not self.history:
            if self.view is not None and self.view.name != "Estado":
                self.go_home(push=False)
                return True
            return False
        view = self.history.pop()
        self._present(view, push=False)
        return True

    def go_home(self, push: bool = True) -> None:
        self._present(View("Estado", "Inicio", self.estado, ["Inicio"]), push=push)

    def open_app(self, root: MenuNode) -> None:
        """La app y su árbol de submenús. Sin hijos, abre su pantalla directo."""
        if not root.children:
            if root.path:
                self.open_path(root.path, [root.name])
            return
        data, index = tree_data(root)
        tree = Tree(data, expanded_depth=1, on_select=lambda path, _v, idx=index, r=root: self._open_tree_leaf(idx.get(tuple(path)), r, path), a11y_label=f"Submenús de {root.name}")
        tree.hint = "→/Enter abren carpeta · ← cierra · * abre todo · Enter en una hoja la abre"  # type: ignore[attr-defined]
        self.app_menu = tree
        self._present(View(f"App: {root.name}", root.name, tree, ["Inicio", root.name]), focus=tree)

    def _open_tree_leaf(self, node: MenuNode | None, root: MenuNode, path: tuple[str, ...]) -> None:
        if node is None or not node.path:
            return
        self.open_path(node.path, ["Inicio", root.name, *path])

    def open_meta(self, meta: dict[str, Any], trail: list[str] | None = None) -> None:
        self.current = meta
        self.list_view = self._meta_list(meta)
        self.table, self.filter = self.list_view.table, self.list_view.filter
        self.form = self._form_for(meta, lazy=True)
        self.shell.pages["Formulario"] = self._frame(self.form)
        title = str(meta.get("name") or meta["resource"])
        view = View("Lista", title, self.list_view.component, trail or ["Inicio", title], lists=[self.list_view], meta=meta, reload=lambda m=meta, t=trail: self._reopen_meta(m, t))
        self._present(view)

    def _reopen_meta(self, meta, trail):
        self.open_meta(meta, trail)

    def open_path(self, path: str, trail: list[str] | None = None) -> None:
        """Abre una hoja del menú como la GUI: pantalla de app, CRUD de app o CRUD del núcleo."""
        clean, _, query = (path or "").partition("?")
        segment = clean.strip("/").removeprefix("internal/")
        trail = trail or ["Inicio", *(trail_for(self.roots, clean) or [segment or "Inicio"])]
        if not segment:
            return self.go_home()
        target = self._resolve(segment)
        if target is None:
            meta = self._meta_for(segment)
            if meta is not None:
                return self.open_meta(meta, trail)
            return self._present(View(f"Pantalla: {segment}", segment, EmptyState(title=f"«/{segment}» aún no se abre en la terminal", message="Ábrela en la GUI. Queda en la lista de vistas pendientes.", a11y_label=segment), trail, unsupported={f"ruta:/{segment}"}))
        slug, page_id, kind, leaf = target
        if kind == "crud" and leaf.get("app_base"):
            return self._open_app_crud(leaf, trail)
        self.open_page(slug, page_id, query, trail)

    def _resolve(self, segment: str) -> tuple[str, str, str, dict[str, Any]] | None:
        for leaf in self.backend.registry_leaves():
            if str(leaf.get("segment") or "").strip("/") == segment and leaf.get("slug"):
                return str(leaf["slug"]), str(leaf.get("page_id") or ""), str(leaf.get("kind") or "page"), leaf
        slugs: list[str] = []
        meta = self._meta_for(segment)
        if meta and meta.get("subject"):
            slugs.append(str(meta["subject"]))
        first = segment.split("/")[0]
        for m in self.metas:
            if m.get("subject") and str(m.get("subject")) not in slugs and (m.get("resource") == first or str(m.get("path") or "").strip("/") == first):
                slugs.append(str(m["subject"]))
        for slug in slugs:
            for page in self.backend.subject_pages(slug):
                if str(page.get("path") or "").strip("/") == segment and page.get("id"):
                    return slug, str(page["id"]), "page", page
        return None

    def _meta_for(self, segment: str) -> dict[str, Any] | None:
        wanted = segment.strip("/")
        for key in ("path", "resource"):
            for meta in self.metas:
                if str(meta.get(key) or "").strip("/") == wanted:
                    return meta
        first = wanted.split("/")[0]
        for meta in self.metas:
            if first and first in (str(meta.get("path") or "").strip("/"), meta.get("resource")):
                return meta
        return None

    def _open_app_crud(self, leaf: dict[str, Any], trail: list[str]) -> None:
        base = "/api/" + str(leaf["app_base"]).strip("/")
        headers = leaf.get("list_headers") if isinstance(leaf.get("list_headers"), dict) else {}
        cols = [Column(k, str(v), image=bool(media.IMAGE_KEYS.search(k))) for k, v in headers.items()] or [Column("name", "Nombre")]
        labels = {c.key: c.label for c in cols}
        title = str(leaf.get("name") or leaf.get("segment"))
        view_list = ViewList(title, cols, fetch=lambda page, size, term: self.backend.list_source(base, page, size, term), on_open=lambda row: self.open_row(row, labels))
        self._present(View(f"Lista: {title}", title, view_list.component, trail, lists=[view_list]))

    def open_page(self, slug: str, page_id: str, query: str = "", trail: list[str] | None = None, *, push: bool = True) -> None:
        descriptor = self.backend.page(slug, page_id, query)
        if descriptor is None:
            message = self.backend.warning or "La app no respondió."
            self.backend.warning = None
            return self._present(View(f"Pantalla: {page_id}", page_id, Alert(message, kind="error", a11y_label="Error"), trail or [page_id]), push=push)
        host = _PageHost(self, slug, page_id, query, trail or [])
        rendered = NoxRenderer(host).render(descriptor)
        title = rendered.title or page_id
        trail = list(trail or ["Inicio", title])
        if trail and trail[-1] != title and query:
            trail = trail + [title]
        view = View(
            f"Pantalla: {page_id}",
            title,
            rendered.component,
            trail,
            lists=rendered.lists,
            search=rendered.search,
            paginator=rendered.paginator,
            images=rendered.images,
            page=(slug, page_id, query),
            unsupported=rendered.unsupported,
        )
        view.reload = lambda: self.open_page(slug, page_id, query, trail, push=False)
        self._present(view, push=push)

    def open_row(self, row: dict[str, Any], labels: dict[str, str] | None = None) -> None:
        self.detail = detail(row, labels or {}, fetch_image=self.backend.fetch_bytes, title="Detalle")
        self.shell.pages["Detalle"] = self._frame(self.detail)
        trail = (self.view.trail if self.view else ["Inicio"]) + [cell(row.get("name") or row.get("nombre") or row.get("codigo") or row.get("_id") or "Detalle")]
        self._present(View("Detalle", "Detalle", self.detail, trail, images=media.row_images(row)))

    def detail_selected(self) -> None:
        lists = self.view.lists if self.view and self.view.lists else ([self.list_view] if self.list_view else [])
        row = lists[0].selected() if lists else None
        labels = getattr(lists[0], "labels", {}) if lists else {}
        if row is None and self.table is not None:
            rows = getattr(self.table, "rows", None) or []
            row = rows[0] if rows and isinstance(rows[0], dict) else None
        self.open_row(row or {}, labels) if row else self._present(View("Detalle", "Detalle", detail(None), ["Inicio", "Detalle"]))

    def edit_selected(self) -> None:
        meta = self.view.meta if self.view and self.view.meta else None
        row = self.view.lists[0].selected() if meta and self.view and self.view.lists else None
        if meta is None:
            return self.show_form()
        self.form = self._form_for(meta, row)
        self.shell.pages["Formulario"] = self._frame(self.form)
        self._present(View("Formulario", "Formulario", self.form, (self.view.trail if self.view else []) + ["Editar" if row else "Alta"]))

    def show_form(self) -> None:
        if self.restringido:
            return self.notify("Sesión restringida: sin altas.", "warning")
        meta = self.view.meta if self.view and self.view.meta else self.current
        self.form = self._form_for(meta)
        self.shell.pages["Formulario"] = self._frame(self.form)
        self._present(View("Formulario", "Formulario", self.form, (self.view.trail if self.view else []) + ["Alta"]))

    def show_images(self) -> bool:
        images: list[tuple[str, str]] = []
        if self.view and self.view.lists:
            images = self.view.lists[0].images()
        if not images and self.view:
            images = list(self.view.images)
        if not images:
            self.notify("Este registro no tiene imágenes.", "info")
            return True
        widget = media.image(*images[0], self.backend.fetch_bytes, height=None) if len(images) == 1 else media.viewer(images, self.backend.fetch_bytes, height=None)
        self._present(View("Imágenes", "Imágenes", widget, (self.view.trail if self.view else []) + ["Imágenes"]), focus=widget if getattr(widget, "focusable", False) else None)
        return True

    def reload(self) -> None:
        if self.view and self.view.lists and not self.view.page:
            for lst in self.view.lists:
                lst.load()
            return
        if self.view and self.view.reload:
            self.view.reload()

    def page_step(self, step: int) -> bool:
        view = self.view
        if view is None:
            return False
        if view.paginator is not None:
            return bool(view.paginator.go(view.paginator.page + step))
        for lst in view.lists:
            return lst.next_page() if step > 0 else lst.prev_page()
        return False

    def focus_filter(self) -> None:
        target = None
        if self.view and self.view.search is not None:
            target = self.view.search
        elif self.view and self.view.lists:
            target = self.view.lists[0].filter
        elif self.filter is not None:
            self.show("Lista")
            target = self.filter
        if target is not None and self.app is not None:
            self.app.focus(target)

    def focus_menu(self) -> None:
        if self.app is not None:
            self.shell.show_sidebar = True
            self.shell.force_sidebar = True
            self.app.focus(self.sidebar)

    def notify(self, message: str, kind: str = "info") -> None:
        if self.app is not None and hasattr(self.app, "notify"):
            self.app.notify(message, kind=kind)
            self.app.announce(message)

    def confirm(self, message: str, then: Callable[[], Any]) -> None:
        if self.app is None:
            then()
            return
        dialog = ConfirmDialog(message, on_confirm=lambda: (self.app.pop(dialog), then()), on_cancel=lambda: self.app.pop(dialog), a11y_label="Confirmar")
        self.app.push(dialog)

    def open_caja(self) -> None:
        self._present(View("Caja", "Caja", self.caja, ["Inicio", "Caja"]), focus=self.caja_input)

    # ----- teclado
    def components(self) -> list[Any]:
        extra: list[Any] = []
        if self.view is not None:
            for lst in self.view.lists:
                extra.extend(lst.components())
        return [c for c in (self.shell, self.sidebar, self.topbar, self.table, self.filter, self.detail, self.form, self.wizard, self.caja, self.caja_input, self.palette, self.app_menu, *extra) if c is not None]

    def typing(self) -> bool:
        """True si el foco está en un campo de texto (o dentro de un Form/FilterBar/Wizard)."""
        node = getattr(self.app, "focused", None)
        seen: set[int] = set()
        while node is not None and id(node) not in seen:
            seen.add(id(node))
            if isinstance(node, (Input, Form, FilterBar, Wizard)):
                return True
            if isinstance(node, DataTable) and getattr(node, "typing", False):
                return True
            node = getattr(node, "parent", None)
        return False

    def _letter(self, action):
        def run():
            if self.typing():
                return False
            result = action()
            return True if result is None else result

        return run

    def _escape(self):
        if self.app is not None and self.app.layers:
            return False
        return self.back()

    def bindings(self) -> dict[str, Any]:
        out = {
            "ctrl+k": (lambda: self.palette.open(self.app), SHORTCUTS["ctrl+k"]),
            "escape": (self._escape, SHORTCUTS["escape"]),
            "backspace": (self._letter(self.back), SHORTCUTS["backspace"]),
            "alt+left": (self.back, SHORTCUTS["alt+left"]),
            "m": (self._letter(self.focus_menu), SHORTCUTS["m"]),
            "h": (self._letter(lambda: self.go_home()), SHORTCUTS["h"]),
            "/": (self._letter(self.focus_filter), SHORTCUTS["/"]),
            "f": (self._letter(self.focus_filter), SHORTCUTS["f"]),
            "n": (self._letter(lambda: self.page_step(1)), SHORTCUTS["n"]),
            "p": (self._letter(lambda: self.page_step(-1)), SHORTCUTS["p"]),
            "r": (self._letter(self.reload), SHORTCUTS["r"]),
            "f5": (self.reload, SHORTCUTS["f5"]),
            "a": (self._letter(self.show_form), SHORTCUTS["a"]),
            "f2": (self.edit_selected, SHORTCUTS["f2"]),
            "f4": (self.detail_selected, SHORTCUTS["f4"]),
            "i": (self._letter(self.show_images), SHORTCUTS["i"]),
            "f6": (self.open_caja, SHORTCUTS["f6"]),
        }
        if self.wizard is not None:
            out["f9"] = (lambda: self._present(View("Masivo", "Asistente masivo", self.wizard, ["Inicio", "Asistente masivo"])), SHORTCUTS["f9"])
        return out


class _PageHost:
    """Lo que el renderer `nox` le pide a la TUI, atado a la app que sirvió la página."""

    def __init__(self, tui: ImperiumTui, slug: str, page_id: str, query: str, trail: list[str]):
        self.tui, self.slug, self.page_id, self.query, self.trail = tui, slug, page_id, query, trail
        self.api_base = f"/api/m/subject-{slug}"

    def navigate(self, target: str) -> None:
        target = (target or "").strip()
        if not target:
            return
        if target.startswith(("http://", "https://")):
            self.tui.notify(f"Enlace externo: {target}")
            return
        if target.startswith("/"):
            return self.tui.open_path(target, None)
        page_id, query = page_id_and_query(target)
        if "." in page_id:
            return self.tui.open_page(self.slug if page_id.startswith(self.slug + ".") or "." in page_id else self.slug, page_id, query, self.trail[:-1] if query else self.trail)
        self.tui.open_path("/" + target, None)

    def page_query(self, updates: dict[str, str]) -> None:
        params = dict(parse_qsl(self.query, keep_blank_values=True))
        for key, value in updates.items():
            if value in (None, ""):
                params.pop(key, None)
            else:
                params[key] = value
        self.tui.open_page(self.slug, self.page_id, urlencode(params), self.trail, push=False)

    def submit(self, action: dict[str, Any], values: dict[str, Any]) -> str | None:
        if self.tui.restringido:
            self.tui.notify("Sesión restringida: sin escrituras.", "warning")
            return None
        path = action["path"]
        url = ("/api/" + path) if path.startswith("m/subject-") else f"{self.api_base}/{path}"
        if action.get("query"):
            url += "?" + action["query"]
        try:
            message = self.tui.backend.write(action["method"], url, values)
        except CliError as err:
            self.tui.notify(err.message, "error")
            return None
        self.tui.notify(message, "success")
        if action.get("then"):
            self.navigate(action["then"])
        else:
            self.tui.open_page(self.slug, self.page_id, self.query, self.trail, push=False)
        return message

    def confirm(self, message: str, then: Callable[[], Any]) -> None:
        self.tui.confirm(message, then)

    def _image_src(self, src: str) -> str:
        if src.startswith("api://"):
            rest = src[len("api://") :]
            return ("/api/" + rest) if rest.startswith("m/") else f"{self.api_base}/{rest}"
        return src

    def fetch_image(self, src: str) -> bytes | None:
        return self.tui.backend.fetch_bytes(self._image_src(src))

    def image_request(self, src: str) -> tuple[str, dict[str, str]] | None:
        """URL y headers para que flexablelib baje la imagen al dibujarla."""
        ask = getattr(self.tui.backend, "image_request", None)
        return ask(self._image_src(src)) if ask is not None else None

    def open_row(self, row: dict[str, Any], labels: dict[str, str]) -> None:
        self.tui.open_row(row, labels)

    def list_rows(self, source: str, page: int, size: int, term: str):
        if source.startswith("api://"):
            rest = source[len("api://") :]
            path = ("/api/" + rest) if rest.startswith("m/") else f"{self.api_base}/{rest}"
        else:
            path = source if source.startswith("/") else f"{self.api_base}/{source}"
        return self.tui.backend.list_source(path, page, size, term)


def run_tui(*, profile: dict[str, Any] | None, accesible: bool = False, keys: list[str] | None = None, backend: Backend | None = None, size: tuple[int, int] | None = None, tui_out: list | None = None):
    use_colors = None if os.environ.get("NO_COLOR") is None else False
    screen_reader = bool(accesible or os.environ.get("TERM") == "dumb" or os.environ.get("IMPERIUM_ACCESIBLE"))
    tui = ImperiumTui(profile, backend)
    footer = KeyHints(FOOTER, use_colors=use_colors)
    app = App(body=tui.shell, footer=Stack([HelpLine(default="F1 ayuda · Ctrl+K paleta · m apps", a11y_label="Ayuda"), footer], a11y_label="Ayuda y atajos"), title="Imperium", keymap=KeyMap(), screen_reader=screen_reader, use_colors=use_colors, bindings=tui.bindings())
    tui.app = app
    app.bindings["q"] = tui._letter(app.exit)
    app.descriptions["q"] = SHORTCUTS["q"]
    if tui_out is not None:
        tui_out.append(tui)
    if keys is not None:
        return app.run(keys=keys, size=size)
    app.run()
    return None


def walk_components(roots: list[Any]) -> list[Any]:
    """Cada componente bajo `roots` (hijos, contenido de Box/Tabs/Accordion), sin repetir."""
    out: list[Any] = []
    seen: set[int] = set()
    stack = list(roots)
    while stack:
        comp = stack.pop(0)
        if comp is None or isinstance(comp, str) or id(comp) in seen:
            continue
        seen.add(id(comp))
        if not hasattr(comp, "a11y"):  # acomodo (Grid/GridCell): solo se atraviesa
            stack.extend(child_nodes(comp))
            continue
        out.append(comp)
        kids = child_nodes(comp)
        for attr in ("tabs", "sections", "items"):
            value = getattr(comp, attr, None)
            if isinstance(value, list):
                kids.extend(v[1] if isinstance(v, tuple) and len(v) == 2 else v for v in value)
        stack.extend(k for k in kids if not isinstance(k, str))
    return out


def audit_shell(profile: dict[str, Any] | None = None, backend: Backend | None = None, tui: ImperiumTui | None = None):
    """Puerta de accesibilidad: lista vacía si las pantallas cumplen el contrato.
    Revisa la pantalla abierta completa (cada componente, no solo los de arriba)."""
    tui = tui or ImperiumTui(profile, backend)
    roots = tui.components() + ([tui.view.component] if tui.view is not None else [])
    return audit(walk_components(roots), check_focus=True)
