"""Pantallas de las apps (descriptores `nox.*`) en la terminal.

Las apps (Herramientas, Vehículos, POS, Tienda…) arman sus pantallas en el
servidor como un árbol `nox.*` (`GET /api/m/<app>/pages/<id>`); la GUI lo
pinta y aquí se pinta con flexablelib. Así «Ver tabla» de Herramientas, la
jornada, la liquidación, etc. se ven sin código propio por pantalla.

Enlaces (`href` `/internal/<hoja>?…`) y `then` (`app.pagina?…`) navegan dentro
de la TUI; `nox.search` y `nox.paginator` vuelven a pedir la página con `q` y
`page`; `nox.form` y los botones con acción escriben vía `api://` (siempre
contra la app que sirvió la página, como la GUI). Lo que no tiene equivalente
se enseña como texto y queda en `unsupported` (la prueba de auditoría lo lista).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from flexablelib_components import (
    Accordion,
    Alert,
    AttachmentList,
    Box,
    Breadcrumbs,
    Button,
    Carousel,
    CatalogGrid,
    Code,
    CommentList,
    DetailView,
    EditableTable,
    EmptyState,
    ErrorPanel,
    Form,
    HtmlView,
    LineChart,
    Link,
    MarkdownView,
    MenuButton,
    Pagination,
    Spinner,
    Split,
    Stack,
    Stat,
    StatusBadge,
    Stepper,
    Tabs,
    Tag,
    TextInput,
    Timeline,
    Timer,
    Toolbar,
    ValidationSummary,
    Badge,
    ScanInput,
    VStack,
)

from . import media
from .fields import form_payload, input_for
from .layout import FORM_MAX_COLUMNS, css_chars, grid, grid_form
from .views import Column, ViewList, cell


class Host(Protocol):
    def navigate(self, target: str) -> None: ...
    def page_query(self, updates: dict[str, str]) -> None: ...
    def submit(self, action: dict[str, Any], values: dict[str, Any]) -> str | None: ...
    def fetch_image(self, src: str) -> bytes | None: ...
    def open_row(self, row: dict[str, Any], labels: dict[str, str]) -> None: ...
    def list_rows(self, source: str, page: int, size: int, term: str) -> tuple[list[dict[str, Any]], int | None]: ...


@dataclass
class Rendered:
    component: Any
    title: str = ""
    lists: list[ViewList] = field(default_factory=list)
    search: Any = None
    paginator: Pagination | None = None
    forms: list[Form] = field(default_factory=list)
    unsupported: set[str] = field(default_factory=set)
    images: list[tuple[str, str]] = field(default_factory=list)


def _t(props: dict[str, Any], *keys: str, default: str = "") -> str:
    for key in keys:
        value = props.get(key)
        if value not in (None, "") and not isinstance(value, (dict, list)):
            return str(value)
    return default


def _items(props: dict[str, Any], *keys: str) -> list[Any]:
    for key in keys or ("items",):
        value = props.get(key)
        if isinstance(value, list):
            return value
    return []


def _kind(kind: str) -> str:
    """`nox.alert` → `alert`; acepta también el id sin prefijo."""
    return kind.removeprefix("nox.")


def parse_action(props: dict[str, Any]) -> dict[str, Any] | None:
    """La misma lectura que `parse_ui_action` del kit: `{method, action}` plano o
    bajo `invoke`, solo `api://` y sin `..`."""
    invoke = props.get("invoke") if isinstance(props.get("invoke"), dict) else props
    method = str(invoke.get("method") or "").upper()
    action = str(invoke.get("action") or "")
    if method not in ("POST", "PATCH", "PUT", "DELETE") or not action.startswith("api://") or ".." in action:
        return None
    path, _, query = action[len("api://") :].partition("?")
    return {
        "method": method,
        "path": path.strip("/"),
        "query": query,
        "body": props.get("body") if isinstance(props.get("body"), dict) else {},
        "confirm": str(props.get("confirm") or "").strip(),
        "then": str(props.get("then") or "").strip(),
    }


class NoxRenderer:
    def __init__(self, host: Host):
        self.host = host
        self.out = Rendered(component=None)

    # ----- entrada
    def render(self, descriptor: dict[str, Any]) -> Rendered:
        self.out = Rendered(component=None, title=str(descriptor.get("title") or ""))
        root = descriptor.get("page") if isinstance(descriptor.get("page"), dict) else descriptor
        component = self.node(root) if isinstance(root, dict) else None
        if component is None:
            component = EmptyState(title="Pantalla vacía", a11y_label=self.out.title or "Pantalla")
        # La página trae su propio buscador/paginador (`nox.search`/`nox.paginator`):
        # las tablas no repiten el suyo y su búsqueda va al servidor de la app.
        for view in self.out.lists:
            if getattr(view, "feature", None) is not None:
                continue
            keep = [view.table]
            if self.out.search is None:
                keep.insert(0, view.filter)
            else:
                view.on_search = lambda term, s=self.out.search: self.host.page_query({getattr(s, "name", None) or "q": term, "page": "1"})
            if self.out.paginator is None and view.pagination.pages > 1:
                keep += [view.pagination, view.status]
            view.show_only(keep)
        # Con tablas, la página es un VStack: la tabla llena el alto que sobra
        # (su cursor y el paginador siempre a la vista) y lo demás se desplaza.
        if self.out.lists and isinstance(component, Stack) and getattr(component, "direction", "vertical") == "vertical":
            component = VStack(list(component.items), a11y_label=component.a11y_label or self.out.title or "Pantalla")
        self.out.component = component
        return self.out

    def children(self, node: dict[str, Any]) -> list[Any]:
        kids = [self.node(c) for c in node.get("children") or [] if isinstance(c, dict)]
        return [k for k in kids if k is not None]

    def stack(self, parts: list[Any], label: str, direction: str = "vertical") -> Any:
        if not parts:
            return None
        if len(parts) == 1 and direction == "vertical":
            return parts[0]
        return Stack(parts, direction=direction, gap=0 if direction == "vertical" else 2, a11y_label=label or "Grupo", min_width=24 if direction == "horizontal" else None)

    def node(self, node: dict[str, Any]) -> Any:
        kind = _kind(str(node.get("component") or ""))
        props = node.get("props") if isinstance(node.get("props"), dict) else {}
        text = str(node.get("text") or props.get("text") or "")
        handler = getattr(self, "_" + kind.replace("-", "_"), None)
        if kind.startswith("input-") and handler is None:
            return self._input(kind, props)
        if handler is None:
            self.out.unsupported.add("nox." + kind)
            return self._fallback(kind, props, node)
        return handler(props, node, text)

    # ----- contenedores
    def _page(self, props, node, text):
        return self.stack(self.children(node), self.out.title or "Pantalla")

    def _stack(self, props, node, text):
        layout = str(props.get("layout") or props.get("direction") or "")
        if layout == "grid":
            kids = self.children(node)
            label = text or _t(props, "title", "label") or "Rejilla"
            return grid(kids, label=label) if len(kids) > 1 else self.stack(kids, label)
        direction = "horizontal" if layout in ("grid", "row", "horizontal", "inline") else "vertical"
        return self.stack(self.children(node), text or _t(props, "title", "label"), direction)

    _shell = _page
    _floating = _stack
    _header_actions = _stack
    _smart_actions = _stack
    _topbar = _stack

    def _card(self, props, node, text):
        body = self.children(node)
        description = _t(props, "description", "body", "content", "subtitle")
        if description:
            body.insert(0, MarkdownView(description, a11y_label=_t(props, "title") or "Tarjeta"))
        title = _t(props, "title", "label") or text
        img = _t(props, "image_url", "image", "src")
        if img and media.looks_like_image(img, "image"):
            body.insert(0, self._image_widget(img, title or "imagen"))
        href = _t(props, "href")
        if href:
            body.append(Link(_t(props, "link_label", "action_label") or "Abrir", url=href, on_open=lambda h=href: self.host.navigate(h), a11y_label=title or "Abrir"))
        inner = self.stack(body, title) or EmptyState(title=title or "—", a11y_label=title or "Tarjeta")
        return Box(inner, title=title or None, a11y_label=title or "Tarjeta")

    def _collapsible(self, props, node, text):
        title = _t(props, "title", "label") or text or "Sección"
        inner = self.stack(self.children(node), title) or EmptyState(title="—", a11y_label=title)
        acc = Accordion([(title, inner)], a11y_label=title)
        if props.get("open") or props.get("expanded"):
            acc.toggle(0)
        return acc

    def _split(self, props, node, text):
        kids = self.children(node)
        if len(kids) < 2:
            return self.stack(kids, text)
        return Split(kids[0], self.stack(kids[1:], text) if len(kids) > 2 else kids[1], ratio=0.3, a11y_label=text or "Paneles")

    def _tabs(self, props, node, text):
        items = _items(props, "items", "tabs")
        kids = self.children(node)
        if kids and len(kids) == len(items):
            tabs = [(_t(i, "label", "title") if isinstance(i, dict) else str(i), k) for i, k in zip(items, kids)]
            return Tabs(tabs, a11y_label=text or "Pestañas")
        # Pestañas que navegan (href): una barra de enlaces.
        buttons = []
        for item in items:
            if isinstance(item, dict):
                label = _t(item, "label", "title") or "Pestaña"
                href = _t(item, "href")
                buttons.append(Button(("● " if item.get("active") else "") + label, (lambda h=href: self.host.navigate(h)) if href else None, a11y_label=label))
        bar = Toolbar(buttons, a11y_label=text or "Pestañas") if buttons else None
        return self.stack([b for b in [bar, *kids] if b is not None], text or "Pestañas")

    def _wizard(self, props, node, text):
        steps = _items(props, "steps", "items")
        labels = [(_t(s, "label", "title") if isinstance(s, dict) else str(s)) for s in steps]
        current = int(props.get("current") or props.get("index") or 0)
        parts = [Stepper(labels or ["Paso"], current=current, a11y_label=text or "Pasos")]
        parts.extend(self.children(node))
        return self.stack(parts, text or "Asistente")

    def _carousel(self, props, node, text):
        slides = self.children(node)
        for item in _items(props, "items", "slides", "images"):
            src = item if isinstance(item, str) else _t(item, "image_url", "image", "src", "url") if isinstance(item, dict) else ""
            if src and media.looks_like_image(src, "image"):
                slides.append(self._image_widget(src, _t(item, "alt", "title") if isinstance(item, dict) else "imagen"))
        if not slides:
            return None
        return Carousel(slides, a11y_label=text or "Carrusel") if len(slides) > 1 else slides[0]

    # ----- texto
    def _markdown_view(self, props, node, text):
        content = _t(props, "content", "markdown", "text", "value") or text
        return MarkdownView(content, a11y_label=_t(props, "title", "label") or "Texto") if content else None

    _markdown = _markdown_view

    def _html(self, props, node, text):
        content = _t(props, "html", "content", "value") or text
        return HtmlView(content, a11y_label=_t(props, "title") or "Texto") if content else None

    def _code(self, props, node, text):
        return Code(_t(props, "code", "content", "value") or text, language=_t(props, "language") or None, a11y_label=_t(props, "title") or "Código")

    def _alert(self, props, node, text):
        kind = _t(props, "kind", "variant", "type", "severity", default="info")
        kind = {"danger": "error", "error": "error", "warning": "warning", "warn": "warning", "success": "success"}.get(kind, "info")
        return Alert(_t(props, "text", "message", "description", "body") or text or "—", kind=kind, title=_t(props, "title") or None, a11y_label="Aviso")

    def _empty(self, props, node, text):
        parts = [EmptyState(title=_t(props, "title", "text") or text or "Sin datos", message=_t(props, "description", "message") or None, a11y_label=_t(props, "title", "text") or "Vacío")]
        parts.extend(self.children(node))
        return self.stack(parts, "Vacío")

    def _error_page(self, props, node, text):
        return ErrorPanel(code=_t(props, "code", "status") or None, title=_t(props, "title") or "Algo salió mal", message=_t(props, "message", "description") or None, a11y_label="Error")

    def _badge(self, props, node, text):
        return Badge(text or _t(props, "label", "value") or "—", kind=_t(props, "kind", "variant", default="info"), a11y_label=text or "Etiqueta")

    def _tag(self, props, node, text):
        return Tag(text or _t(props, "label", "value") or "—", a11y_label=text or "Etiqueta")

    def _status(self, props, node, text):
        return StatusBadge(_t(props, "value", "status") or text or "—", options=props.get("options") if isinstance(props.get("options"), dict) else None, a11y_label="Estado")

    def _breadcrumb(self, props, node, text):
        items = [(_t(i, "label", "title", "text") if isinstance(i, dict) else str(i)) for i in _items(props, "items", "trail")]
        return Breadcrumbs(items or [text or "Inicio"], a11y_label="Migas")

    def _link(self, props, node, text):
        href = _t(props, "href", "url")
        label = text or _t(props, "label") or href or "Enlace"
        return Link(label, url=href or None, on_open=(lambda: self.host.navigate(href)) if href else None, a11y_label=label)

    def _button(self, props, node, text):
        label = text or _t(props, "label") or "Botón"
        href = _t(props, "href")
        action = parse_action(props)
        if action is not None:
            press = lambda a=action, l=label: self._run_action(a, {}, l)
        elif href:
            press = lambda h=href: self.host.navigate(h)
        else:
            press = None
        button = Button(label, press, kind="primary" if props.get("variant") == "primary" else "default", a11y_label=label)
        button.hint = (f"Abre {href}" if href else "Ejecuta la acción" if action else "")  # type: ignore[attr-defined]
        return button

    def _menu_button(self, props, node, text):
        items = []
        for item in _items(props, "items", "actions", "options"):
            if isinstance(item, dict):
                label = _t(item, "label", "text") or "Acción"
                href = _t(item, "href")
                action = parse_action(item)
                run = (lambda a=action, l=label: self._run_action(a, {}, l)) if action else (lambda h=href: self.host.navigate(h)) if href else None
                items.append({"label": label, "action": run})
        label = text or _t(props, "label") or "Acciones"
        return MenuButton(label, items or [{"label": "—"}], a11y_label=label)

    _context_menu = _menu_button

    def _toolbar(self, props, node, text):
        kids = self.children(node)
        buttons = [k for k in kids if isinstance(k, Button)]
        others = [k for k in kids if not isinstance(k, Button)]
        bar = Toolbar(buttons, a11y_label=text or "Acciones") if buttons else None
        return self.stack([p for p in [bar, *others] if p is not None], text or "Acciones")

    # ----- datos
    def _stats(self, props, node, text):
        stats = []
        for item in _items(props, "items", "stats"):
            if isinstance(item, dict):
                label = _t(item, "label", "title", "name") or "—"
                stats.append(Stat(label, _t(item, "value", "body", "amount") or "—", delta=item.get("delta"), a11y_label=label))
        return grid(stats, min_width=20, label=text or "Indicadores") if len(stats) > 1 else self.stack(stats, text or "Indicadores")

    def _detail(self, props, node, text):
        pairs = []
        shown: list[tuple[str, str]] = []
        for item in _items(props, "items", "fields", "rows"):
            if isinstance(item, dict):
                value = item.get("value")
                pairs.append((_t(item, "label", "title", "key") or "—", cell(value)))
                for src in media.image_values(value, _t(item, "label", "key")):
                    shown.append((src, _t(item, "label") or "imagen"))
                    self.out.images.append(shown[-1])
            elif isinstance(item, (list, tuple)) and len(item) == 2:
                pairs.append((str(item[0]), cell(item[1])))
        if not pairs and isinstance(props.get("data"), dict):
            pairs = [(str(k), cell(v)) for k, v in props["data"].items()]
        parts = [DetailView(pairs, columns=2 if len(pairs) > 8 else 1, a11y_label=_t(props, "title") or text or "Detalle")]
        if shown:  # la foto del registro se ve junto al detalle; `i` abre todas
            parts.append(media.image(shown[0][0], shown[0][1], self.host.fetch_image))
        parts.extend(self.children(node))
        return self.stack(parts, text or "Detalle")

    def _timeline(self, props, node, text):
        events = []
        for item in _items(props, "items", "events", "history"):
            if isinstance(item, dict):
                events.append({
                    "when": _t(item, "when", "date", "at", "created_at"),
                    "title": _t(item, "title", "label", "text", "status"),
                    "detail": _t(item, "description", "body", "detail") or None,
                    "kind": _t(item, "kind", "variant") or None,
                })
        return Timeline(events, a11y_label=text or "Historial") if events else EmptyState(title=text or "Sin historial", a11y_label="Historial")

    _history = _timeline
    _status_history = _timeline

    def _status_progress(self, props, node, text):
        steps = [(_t(s, "label", "title") if isinstance(s, dict) else str(s)) for s in _items(props, "steps", "items")]
        current = 0
        for i, s in enumerate(_items(props, "steps", "items")):
            if isinstance(s, dict) and (s.get("current") or s.get("active") or s.get("done")):
                current = i
        return Stepper(steps or [text or "—"], current=current, a11y_label=text or "Progreso")

    _progress = _status_progress

    def _comments(self, props, node, text):
        comments = [{"author": _t(c, "author", "user", "name"), "when": _t(c, "when", "date", "created_at"), "text": _t(c, "text", "body", "content")} for c in _items(props, "items", "comments") if isinstance(c, dict)]
        return CommentList(comments, a11y_label=text or "Comentarios")

    def _attachments(self, props, node, text):
        files = [{"name": _t(f, "name", "title", "url"), "size": f.get("size")} for f in _items(props, "items", "files") if isinstance(f, dict)]
        return AttachmentList(files, a11y_label=text or "Adjuntos")

    def _chart(self, props, node, text):
        series = props.get("series") or props.get("data") or []
        if isinstance(series, list) and series and isinstance(series[0], dict):
            values = {str(s.get("name") or s.get("label") or i): [float(v) for v in s.get("data") or s.get("values") or [] if isinstance(v, (int, float))] for i, s in enumerate(series)}
        elif isinstance(series, list):
            values = [float(v) for v in series if isinstance(v, (int, float))]
        else:
            values = []
        labels = [str(x) for x in props.get("labels") or []] or None
        return LineChart(values or [0.0], labels=labels, a11y_label=text or _t(props, "title") or "Gráfica")

    def _spinner(self, props, node, text):
        return Spinner(text or _t(props, "message", "text") or "Cargando…", a11y_label="Cargando")

    _preloader = _spinner
    _loading_overlay = _spinner

    def _timer(self, props, node, text):
        return Timer(label=text or _t(props, "label") or "Tiempo", interactive=True, a11y_label=text or "Tiempo")

    def _validation(self, props, node, text):
        errors = props.get("errors") or props.get("items") or {}
        if isinstance(errors, list):
            errors = {str(i + 1): (_t(e, "message", "text") if isinstance(e, dict) else str(e)) for i, e in enumerate(errors)}
        return ValidationSummary(errors=errors if isinstance(errors, dict) else {}, a11y_label="Errores")

    def _file_preview(self, props, node, text):
        src = _t(props, "src", "url", "href", "path")
        if src and media.looks_like_image(src, "image"):
            return self._image_widget(src, text or _t(props, "name", "title") or "archivo")
        return Link(text or _t(props, "name", "title") or src or "Archivo", url=src or None, a11y_label="Archivo")

    _pdf_preview = _file_preview

    def _image_viewer(self, props, node, text):
        alt = _t(props, "alt", "title", "caption") or text or "imagen"
        images: list[tuple[str, str]] = []
        for item in _items(props, "images", "items"):
            src = item if isinstance(item, str) else _t(item, "src", "url", "image_url", "image") if isinstance(item, dict) else ""
            if src:
                images.append((src, (_t(item, "alt", "title") if isinstance(item, dict) else "") or alt))
        single = _t(props, "src", "image_url", "image", "url")
        if single:
            images.insert(0, (single, alt))
        if not images:
            return None
        self.out.images.extend(images)
        if len(images) == 1:
            return self._image_widget(*images[0])
        return media.viewer(images, self.host.fetch_image, label=alt)

    def _image_widget(self, src: str, alt: str):
        self.out.images.append((src, alt))
        return media.image(src, alt, self.host.fetch_image)

    def _catalog_grid(self, props, node, text):
        items, raw = [], _items(props, "items", "products")
        for item in raw:
            if not isinstance(item, dict):
                continue
            title = _t(item, "title", "name", "label")
            entry = {
                "title": title,
                "subtitle": _t(item, "subtitle", "brand", "sku"),
                "price": _t(item, "price_label", "price") or None,
                "badge": _t(item, "badge", "status") or None,
                "_raw": item,
            }
            img = _t(item, "image_url", "image", "thumbnail")
            if img:
                self.out.images.append((img, title or "producto"))
                entry["image"], entry["image_alt"] = img, f"Foto de {title or 'producto'}"
            items.append(entry)
        headers = self._catalog_images(items)

        def chosen(item):
            raw_item = item.get("_raw") or {}
            href = _t(raw_item, "href", "url", "link")
            if href:
                self.host.navigate(href)
            else:
                self.host.open_row(raw_item, {})

        return CatalogGrid(items, on_select=chosen, image_height=6, image_method=media.method(), image_headers=headers, a11y_label=text or "Catálogo")

    def _catalog_images(self, items: list[dict[str, Any]]) -> dict[str, str] | None:
        """Las fotos del catálogo se bajan al dibujarse (`image_headers` de
        CatalogGrid) cuando todas van al mismo origen con los mismos headers;
        si no, cada una se baja aquí con los suyos (el token no sale del núcleo)."""
        wanted = [e for e in items if e.get("image") and not str(e["image"]).startswith("data:")]
        asks = [(e, getattr(self.host, "image_request", lambda _s: None)(e["image"])) for e in wanted]
        if asks and all(isinstance(a, tuple) for _e, a in asks) and len({tuple(sorted(a[1].items())) for _e, a in asks}) == 1:
            for e, a in asks:
                e["image"] = a[0]
            return dict(asks[0][1][1])
        for e in items:
            if e.get("image"):
                e["image"] = media.resolve_source(str(e["image"]), self.host.fetch_image)
        return None

    def _table(self, props, node, text):
        columns: list[Column] = []
        labels: dict[str, str] = {}
        for col in _items(props, "columns"):
            if isinstance(col, dict):
                key = _t(col, "key", "name", "field")
                label = _t(col, "label", "title", "header") or key
                if col.get("image_key"):
                    columns.append(Column(str(col.get("image_key")), label, image=True, full=str(col.get("image_full_key") or "")))
                    labels[str(col.get("image_key"))] = label
                    if col.get("image_full_key"):
                        labels[str(col.get("image_full_key"))] = label
                elif key:
                    columns.append(Column(key, label))
                    labels[key] = label
            elif isinstance(col, str):
                columns.append(Column(col, col))
        rows = [r for r in _items(props, "rows", "data", "items") if isinstance(r, dict)]
        if not columns and rows:
            columns = [Column(k, k) for k in rows[0] if not str(k).startswith("_")][:8]

        def open_row(row: dict[str, Any]):
            href = str(row.get("_href") or row.get("href") or "")
            if href:
                self.host.navigate(href)
            else:
                self.host.open_row(row, labels)

        title = _t(props, "title", "label") or self.out.title or "Tabla"
        view = ViewList(title, columns, rows=rows, page_size=max(len(rows), 1) if len(rows) <= 50 else 25, on_open=open_row, empty=text or "Sin registros")
        view.labels = labels  # type: ignore[attr-defined]
        self.out.lists.append(view)
        return view.component

    def _feature_shell(self, props, node, text):
        data = props.get("data") if isinstance(props.get("data"), dict) else {}
        table = props.get("table") if isinstance(props.get("table"), dict) else {}
        view_props = props.get("view") if isinstance(props.get("view"), dict) else {}
        source = str(data.get("list") or "")
        columns = [Column(_t(c, "key"), _t(c, "label") or _t(c, "key"), image=bool(c.get("image") or c.get("image_key"))) for c in table.get("columns") or [] if isinstance(c, dict) and _t(c, "key")]
        labels = {c.key: c.label for c in columns}
        title = _t(view_props, "title") or self.out.title or "Lista"
        view = ViewList(
            title,
            columns,
            fetch=(lambda page, size, term: self.host.list_rows(source, page, size, term)) if source else None,
            on_open=lambda row: self.host.open_row(row, labels),
            empty=_t(view_props, "emptyTitle") or "Sin registros",
        )
        view.labels = labels  # type: ignore[attr-defined]
        view.form_fields = (props.get("form") or {}).get("fields") if isinstance(props.get("form"), dict) else None  # type: ignore[attr-defined]
        view.feature = props  # type: ignore[attr-defined]
        self.out.lists.append(view)
        parts = []
        subtitle = _t(view_props, "subtitle")
        if subtitle:
            parts.append(MarkdownView(subtitle, a11y_label=title))
        parts.append(view.component)
        return self.stack(parts, title)

    # ----- navegación de la página
    def _search(self, props, node, text):
        label = _t(props, "label", "placeholder") or "Buscar"
        name = _t(props, "name") or "q"
        box = TextInput(label=label, value=_t(props, "value"), name=name, a11y_label=label, on_submit=lambda v, n=name: self.host.page_query({n: str(v or ""), "page": "1"}))
        box.hint = "Enter busca"  # type: ignore[attr-defined]
        self.out.search = box
        return box

    _global_search = _search

    def _paginator(self, props, node, text):
        try:
            total = int(props.get("total") or 0)
            size = int(props.get("page_size") or 24)
            page = int(props.get("page") or 1)
        except (TypeError, ValueError):
            total, size, page = 0, 24, 1
        param = _t(props, "param") or "page"
        pag = Pagination(total, page_size=size, page=page, on_change=lambda p, k=param: self.host.page_query({k: str(p)}), a11y_label="Páginas")
        self.out.paginator = pag
        return pag

    def _sort(self, props, node, text):
        from flexablelib_components import SortControl

        options = [(_t(o, "value", "key"), _t(o, "label", "title")) if isinstance(o, dict) else (str(o), str(o)) for o in _items(props, "options", "items", "fields")]
        param = _t(props, "param") or "sort"
        fields = [label for _, label in options] or ["—"]
        keys = [value for value, _ in options] or [""]

        def changed(field_label, descending, keys=keys, fields=fields):
            key = keys[fields.index(field_label)] if field_label in fields else ""
            self.host.page_query({param: key + (":desc" if descending else "")})

        try:
            return SortControl(fields, on_change=changed, a11y_label="Orden")
        except TypeError:
            return None

    def _filters(self, props, node, text):
        kids = self.children(node)
        for group in _items(props, "groups", "items", "facets"):
            if isinstance(group, dict):
                label = _t(group, "label", "title") or "Filtro"
                options = [{"value": _t(o, "value", "href"), "label": _t(o, "label", "title")} for o in _items(group, "options", "items") if isinstance(o, dict)]
                if options:
                    widget = input_for("input-radio-group", {"name": _t(group, "param", "name") or label, "label": label, "options": options})
                    param = _t(group, "param", "name") or "filtro"
                    widget.on_change = lambda v, p=param: self.host.navigate(v) if str(v).startswith("/") else self.host.page_query({p: str(v)})
                    kids.append(widget)
        return self.stack(kids, text or "Filtros")

    # ----- formularios
    def _input(self, kind: str, props: dict[str, Any]):
        if kind == "input-hidden":
            return None
        if kind == "input-subtable":
            return self._subtable(props)
        widget = input_for(kind, props)
        if widget is None:
            return None
        current = getattr(widget, "current", "")
        if current and media.looks_like_image(current, "image"):
            # Entrada con su imagen actual: el Form de flexablelib junta los
            # campos anidados, así que van juntas en una celda de la rejilla.
            box = Stack([widget, self._image_widget(current, widget.label or "imagen")], a11y_label=widget.label or "Imagen")
            for attr in ("imperium_kind", "column_span", "min_width"):
                setattr(box, attr, getattr(widget, attr, None))
            return box
        return widget

    def _subtable(self, props: dict[str, Any]):
        cols = [{"key": _t(c, "key", "name"), "title": _t(c, "label", "title") or _t(c, "key", "name")} for c in _items(props, "columns", "fields") if isinstance(c, dict)]
        rows = props.get("value") if isinstance(props.get("value"), list) else []
        # `name=`: el formulario la junta en `values()` (sus filas), como un campo.
        table = EditableTable(columns=cols or [{"key": "valor", "title": "Valor"}], rows=[r for r in rows if isinstance(r, dict)], name=_t(props, "name") or None, a11y_label=_t(props, "label") or "Subtabla")
        table.imperium_kind = "input-subtable"  # type: ignore[attr-defined]
        box = Box(table, title=_t(props, "label") or None, a11y_label=_t(props, "label") or "Subtabla")
        box.imperium_kind = "input-subtable"  # type: ignore[attr-defined]
        return box

    def _form(self, props, node, text):
        action = parse_action(props)
        hidden: dict[str, Any] = {}
        fields: list[Any] = []
        for child in node.get("children") or []:
            if not isinstance(child, dict):
                continue
            kind = _kind(str(child.get("component") or ""))
            cprops = child.get("props") if isinstance(child.get("props"), dict) else {}
            if kind == "input-hidden":
                if cprops.get("name"):
                    hidden[str(cprops["name"])] = cprops.get("value")
                continue
            rendered = self.node(child)
            if rendered is not None:
                fields.append(rendered)
        title = _t(props, "title", "label") or text or None
        submit_label = _t(props, "submit_label", "submitLabel", "button_label") or "Guardar"
        holder: list[Form] = []

        def submit(values: dict[str, Any]):
            payload = dict(hidden)
            payload.update({k: _jsonable(v) for k, v in form_payload(holder[0], values).items() if k})
            if action is None:
                self.host.page_query({k: str(v) for k, v in payload.items() if v not in (None, "")})
                return
            self._run_action(action, payload, title or "Formulario")

        columns = props.get("columns") or props.get("cols")
        form = grid_form(
            fields or [EmptyState(title="Formulario sin campos", a11y_label="Formulario")],
            on_submit=submit,
            title=title,
            submit_label=submit_label,
            a11y_label=title or "Formulario",
            columns=int(columns) if str(columns or "").isdigit() else FORM_MAX_COLUMNS,
            min_column=css_chars(props.get("column_min_width") or props.get("min_width")),
        )
        holder.append(form)
        form.hint = "Tab cambia de campo · Ctrl+S guarda"  # type: ignore[attr-defined]
        self.out.forms.append(form)
        return form

    def _run_action(self, action: dict[str, Any], values: dict[str, Any], label: str) -> None:
        payload = dict(action.get("body") or {})
        payload.update(values)
        if action.get("confirm"):
            self.host.confirm(action["confirm"], lambda: self.host.submit(action, payload))  # type: ignore[attr-defined]
            return
        self.host.submit(action, payload)

    # ----- piezas sin equivalente directo
    def _scanner(self, props, node, text):
        return ScanInput(label=_t(props, "label") or text or "Escanear", name=_t(props, "name") or "codigo", a11y_label=_t(props, "label") or "Escanear")

    def _numpad(self, props, node, text):
        return input_for("input-number", dict(props, label=_t(props, "label") or "Cantidad"))

    def _stopwatch(self, props, node, text):
        return input_for("input-stopwatch", dict(props, label=_t(props, "label") or text or "Cronómetro"))

    _cronometro = _stopwatch

    def _signature(self, props, node, text):
        return self._input("input-signature", props)

    def _icon_picker(self, props, node, text):
        return input_for("input-icon", props)

    def _coordinates(self, props, node, text):
        return input_for("input-coordinates", props)

    def _color(self, props, node, text):
        return input_for("input-color", props)

    def _mask(self, props, node, text):
        return input_for("input-mask", props)

    def _week(self, props, node, text):
        return input_for("input-week", props)

    def _month(self, props, node, text):
        return input_for("input-month", props)

    def _year(self, props, node, text):
        return input_for("input-year", props)

    def _object(self, props, node, text):
        return input_for("input-object", props)

    def _share_banner(self, props, node, text):
        return Alert(_t(props, "text", "message") or text or "Compartido", kind="info", a11y_label="Aviso")

    def _fallback(self, kind: str, props: dict[str, Any], node: dict[str, Any]):
        kids = self.children(node)
        summary = _t(props, "title", "label", "text", "description") or str(node.get("text") or "")
        note = f"«nox.{kind}» aún no se dibuja en la terminal" + (f": {summary}" if summary else "") + " (ábrelo en la GUI)."
        return self.stack([Alert(note, kind="info", a11y_label="Aviso"), *kids], kind)


def _jsonable(value: Any) -> Any:
    import datetime as _dt

    if isinstance(value, (_dt.date, _dt.datetime, _dt.time)):
        return value.isoformat()
    if isinstance(value, _dt.timedelta):
        return round(value.total_seconds(), 3)
    if isinstance(value, tuple):
        return [_jsonable(v) for v in value]
    if isinstance(value, (list, dict, str, int, float, bool)) or value is None:
        return value
    return str(value)


def page_id_and_query(target: str) -> tuple[str, str]:
    """`herramientas.herr-tabla?id=X` → (`herramientas.herr-tabla`, `id=X`)."""
    page, _, query = target.partition("?")
    return page.strip(), query
