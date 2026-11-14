"""Scroll en toda pantalla (ScrollView/VStack de flexablelib 3.7, siguen al
foco), formularios en la rejilla de `Form` (FormCell, min_column_width) y
acomodos responsivos (GridView), a varios tamaños de terminal."""

from __future__ import annotations

import re

import pytest
from flexablelib_components import Form, GridView, Sidebar, TextInput, VStack

from imperium_cli.tui.app import ImperiumTui, audit_shell, run_tui, walk_components
from imperium_cli.tui.layout import ContentScroll, css_chars, grid_form, span_of
from imperium_cli.tui.fields import input_for

from .tui_fixtures import MENUS, HerrBackend

SIZES = [(60, 16), (100, 24), (160, 40)]
ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
TO_PRODUCTS = ["enter", "right", "down", "enter"]  # Almacén › Inventario › Productos


@pytest.fixture(autouse=True)
def _plain(monkeypatch):
    monkeypatch.setenv("NO_COLOR", "1")
    monkeypatch.setenv("TERM", "xterm-256color")
    monkeypatch.setenv("IMPERIUM_IMAGEN", "braille")


def run(keys, size, backend=None, setup=None):
    """Corre la TUI sin terminal; `setup(tui)` abre una pantalla antes de las teclas
    (en terminal angosta la barra lateral se esconde y no sirve para navegar)."""
    out: list = []
    frame = run_tui(profile=None, keys=[] if setup else keys, backend=backend or HerrBackend(), size=size, tui_out=out)
    tui = out[0]
    if setup is not None:
        setup(tui)
        frame = tui.app.run(keys=keys, size=size)
    return tui, ANSI.sub("", frame).split("\n")


def frame_of(tui):
    return tui.shell.content


def assert_focus_visible(tui):
    frame = frame_of(tui)
    if isinstance(frame, VStack):  # lista: el hijo con el foco queda a la vista
        i = frame._holder()
        assert i is not None, type(tui.app.focused).__name__
        top = sum(frame.heights[:i]) + frame.gap * i
        assert frame.offset <= top < frame.offset + frame.view_height
        return
    assert isinstance(frame, ContentScroll)
    span = frame.focus_rows(frame._last_width - 1)
    assert span is not None, type(tui.app.focused).__name__
    lo, hi = span[0], span[1] + 1
    if hi - lo > frame.view_height:
        assert frame.offset == lo
    else:
        assert frame.offset <= lo and hi <= frame.offset + frame.view_height, (lo, hi, frame.offset, frame.view_height)


def form_columns(tui) -> int:
    return tui.form.grid_columns(frame_of(tui)._last_width - 1)


# ----- rejilla de formularios
def _fields(n=6):
    return [TextInput(label=f"Campo {i}", name=f"c{i}") for i in range(n)]


@pytest.mark.parametrize("width,cols", [(40, 1), (61, 1), (62, 2), (93, 2), (94, 3), (200, 3)])
def test_columnas_segun_ancho(width, cols):
    assert grid_form(_fields()).grid_columns(width) == cols


def test_rejilla_pone_campos_lado_a_lado():
    form = grid_form(_fields())
    wide = form.render(width=120).split("\n")
    assert "Campo 0" in wide[0] and "Campo 1" in wide[0] and "Campo 2" in wide[0]
    narrow = form.render(width=50).split("\n")
    assert not any("Campo 0" in line and "Campo 1" in line for line in narrow)
    assert len(narrow) > len(wide)
    assert "Guardar" in wide[-1] and "Guardar" in narrow[-1]


def test_column_span_y_anchos_completos():
    a, b, c = _fields(3)
    nota = input_for("input-textarea", {"name": "nota", "label": "Nota"})
    doble = input_for("input-text", {"name": "d", "label": "Doble", "column_span": 2})
    completo = input_for("input-text", {"name": "f", "label": "Completo", "column_span": "full"})
    assert span_of(nota) == 3 and span_of(doble) == 2 and span_of(completo) == 3 and span_of(a) == 1
    assert span_of(nota, 2) == 2 and span_of(doble, 1) == 1
    lines = grid_form([a, doble, nota, b, completo, c]).render(width=120).split("\n")
    row = lambda label: next(i for i, line in enumerate(lines) if label in line)  # noqa: E731
    assert row("Campo 0") == row("Doble")  # 1 + 2 = 3 columnas
    assert all(row("Nota") != row(x) for x in ("Campo 0", "Campo 1"))
    assert row("Campo 1") != row("Completo") != row("Campo 2")


def test_min_width_del_nucleo():
    assert css_chars("16rem") == 32 and css_chars("240px") == 30 and css_chars("40ch") == 40 and css_chars("50%") is None
    ancho = input_for("input-text", {"name": "x", "label": "X", "min_width": "24rem"})
    form = grid_form([ancho, *_fields(3)])
    assert form.layout[id(ancho)] == (1, 48)  # FormCell(min_width=): toma más columnas si no cabe
    lines = form.render(width=100).split("\n")
    row = next(line for line in lines if "X" in line and "Campo" in line)
    assert row.count("Campo") == 1  # X ocupa 2 de las 3 columnas


def test_titulos_de_seccion_cortan_la_rejilla():
    a, b, c = _fields(3)
    lines = grid_form([a, "Datos fiscales", b, c]).render(width=120).split("\n")
    titulo = next(i for i, line in enumerate(lines) if "Datos fiscales" in line)
    assert next(i for i, line in enumerate(lines) if "Campo 0" in line) < titulo < next(i for i, line in enumerate(lines) if "Campo 1" in line)


def test_tab_sigue_el_orden_de_lectura():
    fields = _fields(5)
    assert [c for c in grid_form(fields).children() if c in fields] == fields


def test_formulario_crud_y_nox_usan_la_rejilla():
    tui = ImperiumTui(None, HerrBackend())
    tui.open_meta(tui.metas[0])
    tui.show_form()
    assert isinstance(tui.form, Form) and tui.form.min_column_width == 30 and tui.form.columns == 3
    tui.open_path("/herr-jornada")
    form = next(c for c in walk_components([tui.view.component]) if isinstance(c, Form))
    assert form.min_column_width
    assert form.layout[id(next(f for f in form.fields() if f.name == "nota"))][0] == form.columns


def test_nox_form_respeta_columns_y_column_span():
    from imperium_cli.tui.nox import NoxRenderer

    class Host:
        def __getattr__(self, name):
            return lambda *a, **k: None

    desc = {"page": {"component": "nox.form", "props": {"columns": 2, "column_min_width": "10rem"}, "children": [
        {"component": "nox.input-text", "props": {"name": "a", "label": "A"}},
        {"component": "nox.input-text", "props": {"name": "b", "label": "B", "column_span": "full"}},
        {"component": "nox.input-text", "props": {"name": "c", "label": "C"}},
    ]}}
    form = NoxRenderer(Host()).render(desc).forms[0]
    assert form.columns == 2 and form.min_column_width == 20
    assert form.grid_columns(200) == 2 and form.grid_columns(30) == 1
    assert form.layout[id(next(f for f in form.fields() if f.name == "b"))][0] == 2


@pytest.mark.parametrize("size,cols", [((60, 16), 1), ((100, 24), 2), ((160, 40), 3)])
def test_formulario_en_terminal_de_varios_tamanos(size, cols):
    tui, lines = run(TO_PRODUCTS + ["a"], size)
    assert form_columns(tui) == cols
    if cols > 1:
        assert any("Nombre" in line and "Código" in line for line in lines)
    assert len(lines) == size[1]


# ----- scroll que sigue al foco
@pytest.mark.parametrize("size", SIZES)
def test_tab_por_todo_el_formulario_siempre_a_la_vista(size):
    alta = lambda tui: (tui.open_meta(tui.metas[0]), tui.show_form())  # noqa: E731
    reached = False
    for n in range(0, 30):
        tui, lines = run(["tab"] * n, size, setup=alta)
        assert_focus_visible(tui)
        if tui.app.focused is tui.form.submit_button:
            reached = True
            assert any("Guardar" in line for line in lines)
            break
    assert reached  # Tab llega hasta «Guardar» y la vista bajó con él


@pytest.mark.parametrize("size", [(60, 16), (100, 24)])
def test_pgdn_pgup_y_ctrl_fin(size):
    tui, _ = run(TO_PRODUCTS + ["a"], size)
    frame = frame_of(tui)
    assert frame.total > frame.view_height  # el formulario no cabe: hay que desplazarse
    tui, lines = run(TO_PRODUCTS + ["a", "pagedown"], size)
    assert frame_of(tui).offset > 0
    tui, lines = run(TO_PRODUCTS + ["a", "ctrl+end"], size)
    assert frame_of(tui).offset == frame_of(tui).max_offset and any("Guardar" in line for line in lines)
    tui, lines = run(TO_PRODUCTS + ["a", "ctrl+end", "ctrl+home"], size)
    assert frame_of(tui).offset == 0
    tui, _ = run(TO_PRODUCTS + ["a", "pagedown", "pageup"], size)
    assert frame_of(tui).offset == 0


def test_barra_de_scroll_y_lectura():
    tui, lines = run(TO_PRODUCTS + ["a"], (100, 24))
    frame = frame_of(tui)
    assert any(line.rstrip().endswith(("┃", "│")) for line in lines[1:10])
    assert re.match(r"líneas 1-\d+ de \d+", frame.a11y_value())


def test_pagina_de_solo_lectura_se_recorre_con_flechas():
    long = "\n\n".join(f"Párrafo {i}" for i in range(40))

    class B(HerrBackend):
        def page(self, slug, page_id, query=""):
            if page_id == "herramientas.herr-jornada":
                return {"title": "Larga", "page": {"component": "nox.page", "children": [{"component": "nox.markdown-view", "props": {"content": long}}]}}
            return super().page(slug, page_id, query)

    tui, _ = run(["tab", "down", "enter", "down", "down", "enter"], (100, 20), B())
    frame = frame_of(tui)
    assert frame.focusable and tui.app.focused is frame  # sin campos, el propio scroll toma el foco
    tui, lines = run(["tab", "down", "enter", "down", "down", "enter", "down", "down", "end"], (100, 20), B())
    assert frame_of(tui).offset == frame_of(tui).max_offset and any("Párrafo 39" in line for line in lines)


def test_pagina_que_cabe_no_es_parada_de_tab():
    tui, _ = run([], (100, 30))
    assert not frame_of(tui).focusable  # «Estado» cabe: Tab no se detiene en el scroll


def test_lista_se_encoge_y_deja_ver_paginador():
    for h in (16, 18, 24):
        tui, lines = run(TO_PRODUCTS, (100, h))
        text = "\n".join(lines)
        assert "de 45" in text and "Página 1 de" in text, h
        assert frame_of(tui).max_offset == 0, h


def test_cursor_de_tabla_siempre_visible():
    tui, lines = run(["tab", "down", "enter", "down", "enter", "enter", "end"], (100, 18))
    assert any("Ana 25" in line for line in lines)
    assert_focus_visible(tui)


@pytest.mark.parametrize("size", SIZES)
def test_pagina_nox_con_formulario_abajo(size):
    jornada = lambda tui: tui.open_path("/herr-jornada")  # noqa: E731
    tui, _ = run([], size, setup=jornada)
    form = next(c for c in walk_components([tui.view.component]) if isinstance(c, Form))
    stops = [c for c in tui.app.walk(tui.view.component) if getattr(c, "focusable", False)]
    first = stops.index(tui.app.focused)
    tui, lines = run(["tab"] * (stops.index(form.submit_button) - first), size, setup=jornada)
    assert tui.app.focused.label == "Guardar"
    assert tui.app.focused is not None
    assert_focus_visible(tui)


# ----- barra lateral con muchas apps
def _many_apps(n=30):
    return [{"_id": f"a{i}", "name": f"App {i:02d}", "path": f"/x{i}", "order": i} for i in range(n)]


def test_barra_lateral_se_desplaza():
    class B(HerrBackend):
        def menus(self):
            return _many_apps()

    tui, lines = run(["m"] + ["down"] * 25, (100, 16), B())
    assert isinstance(tui.sidebar, Sidebar)
    focused = tui.sidebar.items[tui.sidebar.index]["label"]
    assert any(line.startswith(">") and focused in line for line in lines)  # el cursor se ve
    assert any(re.search(r"[▲^] \d+ más", line) for line in lines)  # Sidebar 3.7 se recorta con ▲/▼
    tui, lines = run(["m", "pagedown"], (100, 16), B())
    assert tui.sidebar.index > 1  # PgDn salta en la barra
    assert any(re.search(r"[▼v] \d+ más", line) for line in lines)


# ----- acomodos de flexablelib
def test_tarjetas_e_indicadores_en_grid():
    from imperium_cli.tui.nox import NoxRenderer

    class Host:
        def __getattr__(self, name):
            return lambda *a, **k: ([], 0) if name == "list_rows" else None

    cards = [{"component": "nox.card", "props": {"title": f"T{i}"}, "children": [{"component": "nox.button", "props": {"href": "/internal/x", "text": "Abrir"}, "text": "Abrir"}]} for i in range(3)]
    out = NoxRenderer(Host()).render({"page": {"component": "nox.stack", "props": {"layout": "grid"}, "children": cards}})
    assert isinstance(out.component, GridView) and out.component.a11y_name()
    assert len([c for c in walk_components([out.component]) if getattr(c, "label", "") == "Abrir"]) == 3  # Tab entra a cada tarjeta
    assert all(f"T{i}" in out.component.render(width=120).split("\n")[0] for i in range(3))  # 3 columnas
    assert not all(f"T{i}" in out.component.render(width=60).split("\n")[0] for i in range(3))  # se reacomoda
    # Los indicadores de «Ver tabla» (nox.stats) también van en Grid.
    tui = ImperiumTui(None, HerrBackend())
    tui.open_page("herramientas", "herramientas.herr-tabla", "id=tabla_1")
    assert any(isinstance(n, GridView) for n in _nodes(tui.view.component))


def _nodes(root):
    from imperium_cli.tui.layout import walk

    return list(walk(root))


# ----- accesibilidad a cada tamaño
@pytest.mark.parametrize("size", SIZES)
def test_auditoria_a_varios_tamanos(size):
    for keys in ([], TO_PRODUCTS, TO_PRODUCTS + ["a"], TO_PRODUCTS + ["f4"], ["tab", "down", "enter", "down", "enter", "enter"], ["tab", "down", "enter", "down", "down", "enter"], ["m", "enter"]):
        tui, lines = run(keys, size)
        assert len(lines) == size[1]
        assert audit_shell(tui=tui) == [], (keys, size)
