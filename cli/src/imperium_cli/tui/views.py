"""Vistas comunes de la TUI.

`ViewList` es el único formato de tabla (el `view-list` de la GUI): búsqueda
arriba, tabla con paginación y orden, y el detalle con imágenes al abrir una
fila. Lo usan las listas CRUD del núcleo, las `nox.table` de las apps
(«Ver tabla» de Herramientas incluida) y los `feature-shell`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable

from flexablelib_components import (
    Alert,
    DataTable,
    DetailView,
    EmptyState,
    FilterBar,
    Pagination,
    Stack,
    StatusLine,
    VStack,
)

from . import media

Fetch = Callable[[int, int, str], tuple[list[dict[str, Any]], int | None]]


def cell(value: Any) -> str:
    """Texto de una celda: el nombre de un objeto relacionado, listas cortas, «Sí/No»."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Sí" if value else "No"
    if isinstance(value, dict):
        for key in ("name", "nombre", "label", "codigo", "folio", "title", "_id", "id"):
            if value.get(key) not in (None, ""):
                return str(value[key])
        return json.dumps(value, ensure_ascii=False)[:80]
    if isinstance(value, list):
        if value and all(isinstance(v, str) and media.looks_like_image(v) for v in value):
            return f"🖼 {len(value)}"
        return ", ".join(cell(v) for v in value[:5]) + ("…" if len(value) > 5 else "")
    if isinstance(value, str) and media.looks_like_image(value):
        return "🖼"
    return str(value)


@dataclass
class Column:
    key: str
    label: str
    image: bool = False
    full: str = ""  # columna con la(s) imagen(es) en grande (`image_full_key`)


class ListTable(DataTable):
    """`/` no abre el filtro local de DataTable (solo filtra la página visible):
    llama `on_search_key`, que lleva al buscador del servidor."""

    on_search_key = None

    def on_key(self, key):
        if str(key) == "/" and not self.typing and self.on_search_key is not None:
            self.on_search_key()
            return True
        return super().on_key(key)

    def draw(self, width, height):
        # `height` es el alto propio (sin lugar asignado); con lugar (el VStack
        # de la pantalla) la tabla lo llena, como pide `fill=True`.
        if not (height and self.fill and self.height):
            return super().draw(width, height)
        own, self.height = self.height, None
        try:
            return super().draw(width, height)
        finally:
            self.height = own


class ViewList:
    """Búsqueda + tabla + paginación. `fetch(pagina, tamano, termino)` trae la
    página del servidor y el total; sin `fetch`, pagina `rows` en memoria.

    `component` es un `VStack`: la tabla (`fill=True`) toma los renglones que
    sobran del buscador, el paginador y el estado, así el paginador nunca
    queda fuera; sin alto (dentro de otra pantalla) la tabla mide `height`."""

    def __init__(
        self,
        title: str,
        columns: list[Column] | list[tuple[str, str]],
        *,
        rows: list[dict[str, Any]] | None = None,
        fetch: Fetch | None = None,
        page_size: int = 20,
        page: int = 1,
        total: int | None = None,
        on_open: Callable[[dict[str, Any]], Any] | None = None,
        on_search: Callable[[str], Any] | None = None,
        on_page: Callable[[int], Any] | None = None,
        empty: str = "Sin registros",
        term: str = "",
        height: int | None = 14,
    ):
        self.title = title
        self.columns = [c if isinstance(c, Column) else Column(str(c[0]), str(c[1])) for c in columns]
        self.fetch = fetch
        self.page_size = max(1, int(page_size))
        self.term = term
        self.on_open = on_open
        self.on_search = on_search
        self.on_page = on_page
        self.error: str | None = None
        self.table = ListTable(
            columns=[{"key": c.key, "title": c.label, "format": cell} for c in self.columns] or [{"key": "_id", "title": "Id"}],
            rows=[],
            selectable=True,
            page_size=None,
            height=height,
            empty=empty,
            on_activate=self._activate,
            fill=True,
            a11y_label=f"Lista de {title}",
        )
        self.table.hint = "Enter abre · Espacio marca · 1-9 ordena · / filtra · n/p página · i imágenes"  # type: ignore[attr-defined]
        self.filter = FilterBar(table=self.table, label="Buscar", a11y_label=f"Buscar en {title}", on_submit=self._submit)
        self.filter.hint = "Escribe para filtrar esta página; Enter busca en el servidor"  # type: ignore[attr-defined]
        self.pagination = Pagination(total or 0, page_size=self.page_size, page=page, on_change=self._go, a11y_label=f"Páginas de {title}")
        self.status = StatusLine(a11y_label=f"Estado de {title}")
        self.alert = Alert("", kind="warning", a11y_label="Aviso")
        self._all_rows = list(rows or [])
        self._server_total = total
        self.component = VStack([self.filter, self.table, self.pagination, self.status], a11y_label=title)
        self.load(page)

    # ----- datos
    @property
    def page(self) -> int:
        return int(self.pagination.page)

    def load(self, page: int | None = None) -> None:
        page = max(1, int(page or self.page))
        if self.fetch is not None:
            try:
                rows, total = self.fetch(page, self.page_size, self.term)
                self.error = None
            except Exception as err:  # noqa: BLE001 - se enseña, no tumba la TUI
                rows, total = [], 0
                self.error = str(getattr(err, "message", err))
            self.table.set_rows(rows)
            known = total if total is not None else (page - 1) * self.page_size + len(rows) + (1 if len(rows) >= self.page_size else 0)
            self.pagination.total = max(0, int(known))
        elif self._server_total is not None:
            self.table.set_rows(self._all_rows)
            self.pagination.total = int(self._server_total)
        else:
            start = (page - 1) * self.page_size
            self.table.set_rows(self._all_rows[start : start + self.page_size])
            self.pagination.total = len(self._all_rows)
        self.pagination.page = max(1, min(page, self.pagination.pages))
        self._status()

    def _status(self) -> None:
        parts = [f"Página {self.pagination.page} de {self.pagination.pages}", f"{self.pagination.total} registros"]
        if self.term:
            parts.append(f"búsqueda «{self.term}» (Esc en el buscador la quita)")
        if self.error:
            parts.append(f"error: {self.error}")
        self.status.left = " · ".join(parts)

    def _go(self, page: int) -> None:
        if self.on_page is not None:
            self.on_page(page)
            return
        self.load(page)

    def next_page(self) -> bool:
        if self.pagination.page < self.pagination.pages:
            self.pagination.go(self.pagination.page + 1)
            return True
        return False

    def prev_page(self) -> bool:
        if self.pagination.page > 1:
            self.pagination.go(self.pagination.page - 1)
            return True
        return False

    def _submit(self, value: str) -> None:
        self.search(str(value or "").strip())

    def search(self, term: str) -> None:
        if self.on_search is not None:
            self.on_search(term)
            return
        if self.fetch is None:
            return
        self.term = term
        self.filter.text = ""
        self.table.invalidate()
        self.load(1)

    def selected(self) -> dict[str, Any] | None:
        row = self.table.current
        return row if isinstance(row, dict) else None

    def _activate(self, row: Any) -> None:
        if self.on_open is not None and isinstance(row, dict):
            self.on_open(row)

    def images(self, row: dict[str, Any] | None = None) -> list[tuple[str, str]]:
        """Imágenes del registro elegido: primero las grandes de las columnas de
        imagen, luego las miniaturas; si la tabla no declara columnas de imagen,
        cualquier valor que parezca imagen."""
        row = row or self.selected() or {}
        title = cell(row.get("name") or row.get("nombre") or row.get("codigo") or row.get("_id") or "registro")
        out: list[tuple[str, str]] = []
        seen: set[str] = set()
        for col in self.columns:
            if not col.image:
                continue
            for key in ([col.full] if col.full else []) + [col.key]:
                for src in media.image_values(row.get(key), key):
                    if src not in seen:
                        seen.add(src)
                        out.append((src, f"{col.label} de {title}"))
                if out and key == col.full:
                    break
        return out or media.row_images(row)

    def components(self) -> list[Any]:
        return [self.filter, self.table, self.pagination, self.status]

    def show_only(self, parts: list[Any]) -> None:
        """Deja en la pantalla solo `parts` (p. ej. sin buscador cuando la
        página trae el suyo); la tabla sigue llenando lo que sobra."""
        stack = self.component
        stack.items = list(parts)
        stack.weights = [1.0 if p is self.table else 0.0 for p in parts]
        stack.min_heights = [0] * len(parts)
        stack.max_heights = [None] * len(parts)


def detail(row: dict[str, Any] | None, labels: dict[str, str] | None = None, *, fetch_image=None, title: str = "Detalle"):
    """Ficha de un registro: campos alineados y, debajo, sus imágenes."""
    if not row:
        return EmptyState(title="Elige una fila y pulsa Enter o F4", a11y_label=title)
    labels = labels or {}
    pairs: list[tuple[str, str]] = []
    for key, value in row.items():
        if str(key).startswith("_") and key not in ("_id",):
            continue
        pairs.append((labels.get(str(key), str(key)), cell(value)))
    parts: list[Any] = [DetailView(pairs, a11y_label=title)]
    images = media.row_images(row)
    if len(images) == 1:
        parts.append(media.image(images[0][0], images[0][1], fetch_image))
    elif images:
        parts.append(media.viewer(images, fetch_image, label=f"Imágenes de {title}"))
    return Stack(parts, a11y_label=title) if len(parts) > 1 else parts[0]
