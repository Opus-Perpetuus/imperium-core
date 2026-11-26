"""Acomodo de pantallas con piezas de flexablelib (3.7+).

- `ContentScroll`: `flexablelib_tui.ScrollView` (sigue al foco por sí solo).
  Toda pantalla que no se acomoda sola va dentro de uno. Aquí solo se decide
  cuándo es parada de Tab (si no cabe y no tiene nada enfocable) y se suman
  Ctrl+Inicio/Fin y Ctrl+↑/↓; PgUp/PgDn y la rueda ya son de la librería.
- `grid_form`: `flexablelib_components.Form` con su rejilla
  (`min_column_width`, `FormCell(span, min_width)`), con los anchos del núcleo.
- `grid`: `GridView` responsivo (tarjetas, indicadores) con nombre accesible.
"""

from __future__ import annotations

import re
from typing import Any

from flexablelib import _frames as _fx
from flexablelib_components import Form, FormCell, GridView
from flexablelib_tui import ScrollView
from flexablelib_tui.app import _child_nodes

# Igual que el formulario web (`FULL_WIDTH_COMPONENTS` del lanzador): ocupan todo el ancho.
FULL_WIDTH_KINDS = {
    "input-textarea", "input-json", "input-markdown", "input-code-editor", "input-editor-html-pdf",
    "input-coordinates", "input-signature", "input-checkbox-group", "input-object", "input-subtable",
}
FORM_MIN_COLUMN = 30  # ≈ 15rem del web (`default_column_min_width`)
FORM_MAX_COLUMNS = 3


def child_nodes(node: Any) -> list[Any]:
    """Hijos directos de cualquier cosa que cabe en una pantalla (lo mismo que
    recorre la App para el foco)."""
    try:
        return list(_child_nodes(node))
    except Exception:  # noqa: BLE001 - un hijo raro no tumba el recorrido
        return []


def walk(node: Any, seen: set[int] | None = None):
    seen = seen if seen is not None else set()
    if node is None or isinstance(node, str) or id(node) in seen:
        return
    seen.add(id(node))
    yield node
    for kid in child_nodes(node):
        yield from walk(kid, seen)


def grid(children: list[Any], *, min_width: int = 32, label: str = "") -> GridView:
    """Rejilla responsiva de flexablelib: tantas columnas de `min_width` como quepan."""
    return GridView(children, columns="auto", min_width=min_width, gap=2, row_gap=1, equal_height=True, a11y_label=label or "Rejilla")


class ContentScroll(ScrollView):
    """`ScrollView` de flexablelib como marco de pantalla."""

    role = "region"

    def __init__(self, content: Any, **kwargs: Any):
        kwargs.setdefault("a11y_label", "Contenido")
        super().__init__(content, follow_focus=True, **kwargs)
        self.bindings.update({
            "ctrl+home": lambda: self.scroll_to(0),
            "ctrl+end": lambda: self.scroll_to(self.max_offset),
            "ctrl+up": lambda: self.scroll(-self.step),
            "ctrl+down": lambda: self.scroll(self.step),
        })

    # Solo es parada de Tab cuando no cabe y lo de adentro no tiene nada
    # enfocable (una ficha o un texto largo): así las flechas lo recorren.
    @property
    def focusable(self) -> bool:  # type: ignore[override]
        if 0 < self.total <= self.view_height and not self.focused:
            return False
        return not any(getattr(n, "focusable", False) for n in walk(self.content))

    def _bar(self):
        # Con foco la barra va en negritas (y se ve aunque no haya qué mover):
        # el foco no depende solo del color.
        if not self.focused:
            return super()._bar()
        bar = super()._bar() if self.total > self.view_height else ["┃"] * self.view_height
        return [self.paint(_fx.strip_ansi(mark), "bold " + self.focus_color) for mark in bar]


# ----- formularios en rejilla
_CSS = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(rem|em|px|ch|%)?\s*$")


def css_chars(value: Any) -> int | None:
    """`min_width` del núcleo (`'16rem'`, `'240px'`, `'30ch'`) en columnas de terminal."""
    if isinstance(value, (int, float)):
        return max(1, int(value))
    m = _CSS.match(str(value or ""))
    if not m:
        return None
    n, unit = float(m.group(1)), (m.group(2) or "ch")
    if unit == "%":
        return None
    return max(1, round(n * 2 if unit in ("rem", "em") else n / 8 if unit == "px" else n))


def span_of(item: Any, columns: int = FORM_MAX_COLUMNS) -> int:
    """Columnas que pide el campo: `column_span` (1, 2… o 'full'); los anchos van completos."""
    span = getattr(item, "column_span", None)
    if span == "full":
        return columns
    try:
        if span is not None and int(span) > 0:
            return min(columns, int(span))
    except (TypeError, ValueError):
        pass
    kind = getattr(item, "imperium_kind", "")
    if kind in FULL_WIDTH_KINDS or getattr(item, "full_width", False):
        return columns
    return 1


def grid_form(fields: list[Any], *, columns: int | None = None, min_column: int | None = None, **kwargs: Any) -> Form:
    """`Form` de flexablelib en su rejilla: hasta `columns` columnas de al
    menos `min_column` (1 en terminal angosta, 2-3 en anchas), cada campo con
    su `column_span` y su `min_width` del núcleo. Los títulos (cadenas) cortan
    la rejilla y el orden de Tab es el de lectura."""
    cols = max(1, int(columns or FORM_MAX_COLUMNS))
    cells = [f if isinstance(f, str) else FormCell(f, span=span_of(f, cols), min_width=css_chars(getattr(f, "min_width", None))) for f in fields]
    return Form(cells, columns=cols, min_column_width=int(min_column or FORM_MIN_COLUMN), **kwargs)
