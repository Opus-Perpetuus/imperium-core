"""TUI completa: menú por apps, todas las entradas de flexablelib, imágenes,
teclado, pantallas `nox.*` de las apps («Ver tabla» de Herramientas) y la
auditoría de accesibilidad en cada pantalla."""

from __future__ import annotations

import pytest
from flexablelib_components import (
    CheckboxGroup,
    DataTable,
    EditableTable,
    FilterBar,
    Form,
    Image,
    ImageViewer,
    Select,
    Tree,
)

from imperium_cli.tui import fields as F
from imperium_cli.tui import media
from imperium_cli.tui.app import ImperiumTui, audit_shell, run_tui, walk_components
from imperium_cli.tui.menu import build_tree, trail_for, tree_data
from imperium_cli.tui.nox import NoxRenderer, parse_action
from imperium_cli.tui.views import ViewList, cell

from .tui_fixtures import MENUS, HerrBackend, herr_jornada, png

# Catálogo de componentes del kit (imperium-core-kit, NOX_UI_COMPONENT_ALLOWLIST).
NOX_ALLOWLIST = [
    "nox.alert", "nox.attachments", "nox.badge", "nox.breadcrumb", "nox.button", "nox.card", "nox.carousel",
    "nox.catalog-grid", "nox.chart", "nox.code", "nox.collapsible", "nox.color", "nox.comments", "nox.context-menu",
    "nox.coordinates", "nox.detail", "nox.empty", "nox.error-page", "nox.excel-import", "nox.feature-shell",
    "nox.file-preview", "nox.filters", "nox.floating", "nox.form", "nox.global-search", "nox.header-actions",
    "nox.history", "nox.html", "nox.icon-picker", "nox.image-viewer", "nox.input-checkbox", "nox.input-checkbox-group",
    "nox.input-choice", "nox.input-code-editor", "nox.input-color", "nox.input-coordinates", "nox.input-datalist",
    "nox.input-date", "nox.input-date-range", "nox.input-datetime", "nox.input-editor-html-pdf", "nox.input-file",
    "nox.input-hidden", "nox.input-icon", "nox.input-image", "nox.input-json", "nox.input-markdown", "nox.input-mask",
    "nox.input-menu", "nox.input-money", "nox.input-month", "nox.input-number", "nox.input-object",
    "nox.input-operacion", "nox.input-password", "nox.input-radio-buttons", "nox.input-radio-group",
    "nox.input-scanner", "nox.input-signature", "nox.input-status", "nox.input-subtable", "nox.input-switch",
    "nox.input-text", "nox.input-textarea", "nox.input-time", "nox.input-timer", "nox.input-week",
    "nox.input-weekday", "nox.input-year", "nox.link", "nox.loading-overlay", "nox.login", "nox.markdown",
    "nox.markdown-view", "nox.mask", "nox.menu-button", "nox.month", "nox.numpad", "nox.object", "nox.page",
    "nox.paginator", "nox.pdf-preview", "nox.preloader", "nox.progress", "nox.scanner", "nox.search",
    "nox.share-banner", "nox.shell", "nox.sidebar", "nox.signature", "nox.smart-actions", "nox.sort", "nox.spinner",
    "nox.split", "nox.stack", "nox.stats", "nox.status", "nox.status-history", "nox.status-progress", "nox.table",
    "nox.tabs", "nox.tag", "nox.timeline", "nox.timer", "nox.toolbar", "nox.topbar", "nox.validation", "nox.week",
    "nox.wizard", "nox.year",
]
# Sin pantalla equivalente en terminal (se avisan, no se dibujan): ver README.
NOX_SIN_TERMINAL = {"nox.login", "nox.excel-import", "nox.sidebar"}


@pytest.fixture
def tui():
    return ImperiumTui(None, HerrBackend())


# ----- 1. menú: la barra lateral solo enseña apps; la app abre su árbol
def test_sidebar_solo_apps(tui):
    labels = [i["label"] for i in tui.sidebar.items if not i.get("heading") and not i.get("separator")]
    assert labels[:3] == ["Almacén", "Herramientas", "Ventas"]
    assert "Ver tabla" not in labels and "Productos" not in labels and "Por surtir" not in labels


def test_arbol_anidado_y_plegable(tui):
    roots = build_tree(MENUS)
    almacen = roots[0]
    assert [c.name for c in almacen.children] == ["Inventario"]
    assert [c.name for c in almacen.children[0].children] == ["Productos", "Surtido"]
    assert trail_for(roots, "/pedidos/surtir") == ["Almacén", "Inventario", "Surtido", "Por surtir"]
    assert all(n.name != "Inactivo" for r in roots for _t, n in r.leaves())
    tui.open_app(almacen)
    tree = tui.view.component
    assert isinstance(tree, Tree) and tui.view.trail == ["Inicio", "Almacén"]
    names = lambda: [r[1] for r in tree.rows()]  # noqa: E731
    assert names() == ["Inventario"]  # carpeta cerrada: solo el primer nivel
    tree.on_key("right")  # abre «Inventario»
    assert names() == ["Inventario", "Productos", "Surtido"]
    tree.index = 2
    tree.on_key("enter")  # Enter en carpeta la abre
    assert names()[-1] == "Por surtir"
    tree.on_key("left")  # la vuelve a cerrar
    assert "Por surtir" not in names()
    tree.on_key("*")
    tree.index = [r[1] for r in tree.rows()].index("Productos")
    tree.on_key("enter")
    assert tui.view.name == "Lista" and tui.view.trail == ["Inicio", "Almacén", "Inventario", "Productos"]


def test_app_sin_hijos_abre_directo(tui):
    ventas = build_tree(MENUS)[2]
    tui.open_app(ventas)
    assert tui.view.name == "Lista" and tui.current["resource"] == "pedidos"


def test_hermanos_con_el_mismo_nombre():
    roots = build_tree([{"_id": "r", "name": "App"}, {"_id": "a", "name": "X", "path": "/a", "parent_id": "r"}, {"_id": "b", "name": "X", "path": "/b", "parent_id": "r"}])
    _data, index = tree_data(roots[0])
    assert index[("X",)].path == "/a" and index[("X (2)",)].path == "/b"


def test_ciclo_en_menus_no_se_cuelga():
    roots = build_tree([{"_id": "a", "name": "A", "parent_id": "b"}, {"_id": "b", "name": "B", "parent_id": "a"}])
    assert {r.name for r in roots} <= {"A", "B"} and roots


# ----- 2. todas las entradas de flexablelib
def test_cada_entrada_de_flexablelib_sale_del_registro():
    sample = {"options": [{"value": "a", "label": "A"}, {"value": "b", "label": "B"}]}
    produced = {type(F.input_for(kind, dict(sample, name="x", label="X"))) for kind in F.KINDS}
    covered = {base for cls in produced for base in cls.__mro__}
    # FilterBar es el buscador de ViewList (ver test_viewlist_*).
    missing = {c.__name__ for c in F.flexablelib_input_classes() if c not in covered} - {"FilterBar"}
    assert missing == set()


def test_cada_input_nox_tiene_tipo():
    inputs = [k.removeprefix("nox.") for k in NOX_ALLOWLIST if k.startswith("nox.input-")]
    assert [k for k in inputs if k not in F.KINDS and k not in F.NON_FIELDS] == []


@pytest.mark.parametrize("field,expected", [
    ({"name": "precio", "component": "input-money", "type": "number"}, "MoneyInput"),
    ({"name": "existencia", "component": "input-number", "type": "number"}, "NumberInput"),
    ({"name": "is_active", "component": "input-checkbox", "type": "boolean"}, "Checkbox"),
    ({"name": "datos", "component": "input-json", "type": "json"}, "JsonInput"),
    ({"name": "fecha", "component": "input-date", "type": "string"}, "DateInput"),
    ({"name": "description", "component": "input-textarea", "type": "string"}, "TextArea"),
    ({"name": "icono", "component": "input-icon", "type": "string"}, "IconPicker"),
    ({"name": "image", "component": "input-text", "type": "string"}, "ImageFileInput"),
    ({"name": "telefono", "component": "input-text", "type": "string"}, "MaskedInput"),
    ({"name": "rfc", "component": "input-text", "type": "string"}, "MaskedInput"),
    ({"name": "color", "component": "input-text", "type": "string"}, "ColorInput"),
    ({"name": "created_at", "component": "input-text", "type": "string"}, "DateTimeInput"),
    ({"name": "u", "component": "input-text", "options": [{"value": 1, "label": "a"}] * 5}, "Select"),
    ({"name": "u", "component": "input-text", "options": [{"value": 1, "label": "a"}]}, "RadioGroup"),
    ({"name": "categoria", "component": "input-text", "ref": "product-category"}, "Autocomplete"),
    ({"name": "total", "component": "", "type": "number"}, "MoneyInput"),
    ({"name": "x", "component": "", "type": "boolean"}, "Checkbox"),
    ({"name": "nombre", "component": "input-text", "type": "string"}, "TextInput"),
])
def test_meta_a_entrada(field, expected):
    widget = F.meta_input(dict(field, label=field["name"]), options_loader=lambda ref: [{"value": "c1", "label": "Bebidas"}])
    assert type(widget).__name__ == expected


def test_valores_iniciales_se_convierten():
    import datetime as dt

    assert F.input_for("input-date", {"name": "d", "value": "2026-11-13"}).value == dt.date(2026, 11, 13)
    assert F.input_for("input-datetime", {"name": "d", "value": "2026-11-13T10:00:00Z"}).value == dt.datetime(2026, 11, 13, 10, 0)
    assert F.input_for("input-date-range", {"name": "d", "value": {"start": "2026-11-01", "end": "2026-11-13"}}).value == (dt.date(2026, 11, 1), dt.date(2026, 11, 13))
    assert F.input_for("input-coordinates", {"name": "c", "value": "20.6,-103.2"}).value == {"latitude": 20.6, "longitude": -103.2}
    assert F.input_for("input-checkbox-group", {"name": "g", "value": "a,b", "options": ["a", "b"]}).value == ["a", "b"]
    assert F.input_for("input-weekday", {"name": "w", "value": "mié"}).value == 2
    assert F.input_for("input-year", {"name": "y", "value": "2026"}).value == 2026
    assert F.input_for("input-mask", {"name": "t", "value": "3312345678", "mask": "phone"}).value == "(331) 234-5678"
    scan = F.input_for("input-scanner", {"name": "s"})
    scan.text = "ABC123"
    scan.submit()
    assert scan.value == "ABC123"  # el lector limpia el texto pero el formulario conserva el código


def test_formulario_crud_con_todos_los_tipos_y_guardado(tui):
    tui.open_meta(tui.metas[0])
    tui.show_form()
    form = tui.view.component
    assert isinstance(form, Form)
    kinds = {type(f).__name__ for f in form.fields()}
    assert {"TextInput", "MoneyInput", "NumberInput", "Checkbox", "JsonInput", "Select", "RadioGroup", "DateInput", "TextArea", "IconPicker", "ImageFileInput", "Autocomplete"} <= kinds
    values = {f.name: f for f in form.fields()}
    values["name"].value = "Café"
    values["precio"].value = 25
    form.submit()
    method, path, body = tui.backend.writes[-1]
    assert (method, path) == ("POST", "/api/products") and body["name"] == "Café" and body["precio"] == 25


def test_formulario_valida_obligatorios(tui):
    tui.open_meta(tui.metas[0])
    tui.show_form()
    tui.view.component.submit()
    assert tui.backend.writes == [] and tui.view.component.errors


def test_editar_registro_elegido_hace_patch(tui):
    tui.open_meta(tui.metas[0])
    tui.edit_selected()
    form = tui.view.component
    fields = {f.name: f for f in form.fields()}
    assert fields["name"].value == "Producto 1"
    fields["name"].value = "Producto uno"
    form.submit()
    assert tui.backend.writes[-1][:2] == ("PATCH", "/api/products/p01")


# ----- 3. imágenes
def test_detecta_imagenes():
    assert media.looks_like_image("/api/files/a.png")
    assert media.looks_like_image("https://x.mx/img/a.JPG?v=2")
    assert media.looks_like_image("data:image/png;base64,AAAA")
    assert media.looks_like_image("/api/files/abc", "foto")
    assert not media.looks_like_image("hola", "foto") and not media.looks_like_image("/api/x", "nombre")
    assert media.image_values('["/a.png", "/b.webp"]', "fotos") == ["/a.png", "/b.webp"]
    assert media.image_values({"url": "/c.jpg"}) == ["/c.jpg"]
    assert cell(["/a.png", "/b.png"]) == "🖼 2" and cell("/a.png") == "🖼"


def test_imagen_se_baja_con_token_y_se_dibuja(monkeypatch):
    monkeypatch.setenv("IMPERIUM_IMAGEN", "half")
    widget = media.image("/api/files/a.png", "Foto", lambda src: png())
    assert isinstance(widget.source, bytes) and widget.alt == "Foto"
    assert widget.bitmap() is not None  # el PNG bajado con token se decodifica
    # IMPERIUM_IMAGEN=half dibuja bloques y el alt de pie; si el raster no
    # arranca, flexablelib cae al texto alternativo.
    rendered = widget.render(width=40)
    assert "Foto" in rendered
    assert "█" in rendered or "▄" in rendered or "Imagen: Foto" in rendered
    data = media.image("data:image/png;base64," + __import__("base64").b64encode(png()).decode(), "x", None)
    assert data.source == png()


def test_imagen_rota_no_tumba():
    def boom(_src):
        raise OSError("caída")

    widget = media.image("/api/files/a.png", "Foto", boom)
    assert widget.source == "/api/files/a.png"
    assert widget.render(width=20) is not None


def test_backend_baja_imagenes_del_nucleo_con_token(monkeypatch):
    from imperium_cli.tui import app as app_mod

    seen = []

    def fake_read(url, timeout=5.0, max_bytes=0, headers=None):
        seen.append((url, (headers or {}).get("Authorization")))
        return png(), url

    monkeypatch.setattr(app_mod, "read_source", fake_read)
    backend = app_mod.Backend({"url": "https://nucleo.mx", "token": "icli_T"})
    assert backend.fetch_bytes("/api/files/a.png") == png()
    assert backend.fetch_bytes("https://nucleo.mx/api/files/b.png") == png()
    assert backend.fetch_bytes("https://cdn.otro.mx/c.png") == png()
    assert backend.fetch_bytes("//cdn.otro.mx/c.png") == png()
    assert backend.fetch_bytes("api://files/d.png") == png()
    assert seen == [
        ("https://nucleo.mx/api/files/a.png", "Bearer icli_T"),
        ("https://nucleo.mx/api/files/b.png", "Bearer icli_T"),
        ("https://cdn.otro.mx/c.png", None),
        ("https://cdn.otro.mx/c.png", None),
        ("https://nucleo.mx/api/files/d.png", "Bearer icli_T"),
    ]


def test_token_de_imagen_no_sigue_redirecciones():
    """flexablelib 3.7 (`read_source(headers=)`) manda Authorization sin
    reenviarlo a un redirect: el token del perfil no sale del núcleo."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from imperium_cli.tui.app import Backend

    got: dict[str, str | None] = {}

    class H(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            got[self.path] = self.headers.get("Authorization")
            if self.path == "/api/files/a.png":
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{srv.server_port}/cdn/a.png")
                self.end_headers()
                return
            body = png()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        backend = Backend({"url": f"http://127.0.0.1:{srv.server_port}", "token": "icli_T"})
        assert backend.fetch_bytes("/api/files/a.png") == png()
    finally:
        srv.shutdown()
    assert got == {"/api/files/a.png": "Bearer icli_T", "/cdn/a.png": None}


def test_detalle_de_producto_con_imagen(tui):
    tui.open_meta(tui.metas[0])
    tui.detail_selected()
    found = [c for c in walk_components([tui.view.component]) if isinstance(c, Image)]
    assert found and found[0].alt.startswith("image")
    assert ("img", "/api/files/p1.png") in tui.backend.calls


# ----- 4. vistas: «Ver tabla» de Herramientas y demás pantallas nox
def _open_ver_tabla(tui):
    tui.open_path("/herr-tabla")
    assert tui.view.page[1] == "herramientas.herr-tabla"
    abrir = next(c for c in walk_components([tui.view.component]) if getattr(c, "label", "") == "Abrir")
    abrir.press()
    return tui.view


def test_ver_tabla_herramientas(tui):
    view = _open_ver_tabla(tui)
    assert view.page == ("herramientas", "herramientas.herr-tabla", "id=tabla_1")
    assert view.trail == ["Inicio", "Herramientas", "Ver tabla", "Préstamos"]
    assert len(view.lists) == 1
    lista = view.lists[0]
    assert [c.label for c in lista.columns] == ["Nombre", "Monto", "Foto"]
    assert lista.columns[2].image and len(lista.table.rows) == 25
    assert view.search is not None and view.paginator is not None and view.paginator.pages == 3
    assert lista.filter not in lista.component.items  # el buscador de la página manda
    assert tui.unsupported == set()


def test_ver_tabla_paginacion_busqueda_y_fila(tui):
    _open_ver_tabla(tui)
    assert tui.page_step(1)
    assert tui.backend.calls[-1] == ("page", "herramientas", "herramientas.herr-tabla", "id=tabla_1&page=2")
    assert tui.view.lists[0].table.rows[0]["nombre"] == "Ana 26"
    tui.view.search.on_submit("Ana 3")
    assert tui.backend.calls[-1][3] == "id=tabla_1&page=1&q=Ana+3"
    images = tui.view.lists[0].images()
    assert images[0][0].endswith("/f3.png") and images[1][0].startswith("data:image/png")
    tui.show_images()
    assert isinstance(tui.view.component, ImageViewer) and len(tui.view.component.items) == 2
    tui.back()
    tui.view.lists[0].table.on_key(type("K", (), {"__str__": lambda s: "enter", "is_printable": False, "char": ""})())
    assert tui.view.name == "Pantalla: herr-registro"  # el _href de la fila navega


def test_pantalla_nox_con_formulario_y_acciones(tui):
    tui.open_path("/herr-jornada")
    comps = walk_components([tui.view.component])
    form = next(c for c in comps if isinstance(c, Form))
    kinds = {type(f).__name__ for f in form.fields()}
    assert {"MoneyInput", "Select", "TextArea", "ImageFileInput"} <= kinds
    assert any(isinstance(c, EditableTable) for c in comps)
    assert any(isinstance(c, ImageViewer) for c in comps)
    assert any(isinstance(c, Image) and c.alt == "Foto" for c in comps)
    form.submit()
    method, path, body = tui.backend.writes[-1]
    assert (method, path) == ("POST", "/api/m/subject-herramientas/herr-jornadas/cerrar")
    assert body["jornada_id"] == "j1" and body["efectivo"] == 500 and body["responsable"] == "ana"
    assert body["gastos"] == [{"concepto": "Gas", "monto": 100}]
    last_page = [c for c in tui.backend.calls if c[0] == "page"][-1]
    assert last_page == ("page", "herramientas", "herramientas.herr-jornada", "cerrada=1")  # `then`


def test_boton_con_accion_y_confirmacion(tui):
    tui.open_path("/herr-jornada")
    pausar = next(c for c in walk_components([tui.view.component]) if getattr(c, "label", "") == "Pausar")
    pausar.press()  # sin App la confirmación pasa directo
    assert tui.backend.writes[-1][:2] == ("POST", "/api/m/subject-herramientas/herr-jornadas/pausar")


def test_feature_shell_lista_paginada(tui):
    tui.open_path("/herr-tablas")
    lista = tui.view.lists[0]
    assert ("source", "/api/m/subject-herramientas/herr-tablas", 1, 20, "") in tui.backend.calls
    assert lista.table.rows[0]["name"] == "Préstamos"


def test_ruta_desconocida_avisa(tui):
    tui.open_path("/no-existe")
    assert "ruta:/no-existe" in tui.unsupported


def test_cada_componente_nox_se_dibuja():
    class Host:
        def __getattr__(self, name):
            return lambda *a, **k: ([], 0) if name == "list_rows" else None

    sample = {"text": "x", "label": "X", "name": "x", "title": "T", "items": [{"label": "a", "value": "1"}], "options": [{"value": "a", "label": "A"}], "columns": [{"key": "a", "label": "A"}], "rows": [{"a": 1}], "images": ["/a.png"], "steps": ["a", "b"], "total": 30, "page_size": 10}
    renderer = NoxRenderer(Host())
    for kind in NOX_ALLOWLIST:
        out = renderer.render({"title": kind, "page": {"component": "nox.page", "children": [{"component": kind, "props": dict(sample), "children": [{"component": "nox.markdown-view", "props": {"content": "hijo"}}]}]}})
        assert out.component is not None, kind
        out.component.render(width=60)
        if kind not in NOX_SIN_TERMINAL:
            assert kind not in out.unsupported, kind
    assert renderer.render({"page": {"component": "nox.login"}}).unsupported == {"nox.login"}


def test_parse_action_solo_api():
    assert parse_action({"method": "POST", "action": "api://x/y?z=1"})["path"] == "x/y"
    assert parse_action({"invoke": {"method": "PATCH", "action": "api://x"}})["method"] == "PATCH"
    assert parse_action({"method": "POST", "action": "https://malo.mx"}) is None
    assert parse_action({"method": "POST", "action": "api://../x"}) is None
    assert parse_action({"method": "GET", "action": "api://x"}) is None


# ----- 5. view-list
def test_viewlist_pagina_en_servidor_y_busca():
    calls = []

    def fetch(page, size, term):
        calls.append((page, size, term))
        rows = [{"_id": str(i), "name": f"n{i}"} for i in range(100) if term in f"n{i}"]
        return rows[(page - 1) * size : page * size], len(rows)

    view = ViewList("X", [("name", "Nombre")], fetch=fetch, page_size=10)
    assert view.pagination.pages == 10 and isinstance(view.filter, FilterBar) and isinstance(view.table, DataTable)
    assert view.next_page() and calls[-1] == (2, 10, "")
    view.filter.text = "n9"
    view.filter.on_submit("n9")
    assert calls[-1] == (1, 10, "n9") and view.term == "n9" and view.filter.text == ""
    assert "búsqueda «n9»" in view.status.left
    assert not view.prev_page()


def test_viewlist_en_memoria():
    view = ViewList("X", [("a", "A")], rows=[{"a": i} for i in range(45)], page_size=20)
    assert view.pagination.pages == 3 and len(view.table.rows) == 20
    view.next_page()
    assert view.table.rows[0]["a"] == 20


# ----- 6. teclado
def test_teclado_completo_headless(monkeypatch):
    monkeypatch.setenv("NO_COLOR", "1")
    monkeypatch.setenv("TERM", "xterm-256color")
    out = []
    keys = [
        "tab", "down", "enter",  # Herramientas → árbol
        "down", "enter",  # Ver tabla
        "enter",  # botón Abrir de la tarjeta
        "n", "p",  # páginas
        "/", "A", "n", "a", "enter",  # buscar en la página
        "escape",
        "i", "escape",  # imágenes y volver
        "f4", "escape",
        "m", "h", "backspace", "alt+left",
        "ctrl+k", "escape",
        "f1", "escape",
        "r", "f5", "q",
    ]
    frame = run_tui(profile=None, keys=keys, backend=HerrBackend(), size=(100, 30), tui_out=out)
    tui = out[0]
    pages = [c for c in tui.backend.calls if c[0] == "page"]
    assert ("page", "herramientas", "herramientas.herr-tabla", "id=tabla_1&page=2") in pages
    assert any(c[3].endswith("q=Ana") for c in pages)
    assert frame and "F1" in frame


def test_letras_no_se_roban_al_escribir(monkeypatch):
    monkeypatch.setenv("TERM", "xterm-256color")
    out = []
    run_tui(profile=None, keys=["tab", "down", "enter", "down", "enter", "enter", "/", "n", "p", "q"], backend=HerrBackend(), size=(100, 30), tui_out=out)
    tui = out[0]
    assert tui.view.search.text == "npq"  # n, p y q se escribieron, no paginaron ni salieron
    assert not any(c[3].endswith("page=2") for c in tui.backend.calls if c[0] == "page")


def test_escape_vuelve_por_el_historial(tui):
    tui.open_app(build_tree(MENUS)[1])
    tui.open_path("/herr-tabla")
    tui.open_path("/herr-jornada")
    assert tui.back() and tui.view.page[1] == "herramientas.herr-tabla"
    assert tui.back() and tui.view.name == "App: Herramientas"
    assert tui.back() and tui.view.name == "Estado"
    assert not tui.back()


def test_ayuda_lista_los_atajos():
    out = []
    run_tui(profile=None, keys=[], backend=HerrBackend(), tui_out=out)
    hints = dict(out[0].app.key_hints())
    for label in ("Volver", "Buscar", "Página siguiente", "Imágenes del registro", "Ir al menú de apps", "Recargar"):
        assert label in hints.values()


# ----- 7. accesibilidad en cada pantalla
def test_auditoria_en_cada_pantalla(tui, monkeypatch):
    monkeypatch.setenv("IMPERIUM_IMAGEN", "half")
    screens = [
        lambda: None,
        lambda: tui.open_app(build_tree(MENUS)[0]),
        lambda: tui.open_meta(tui.metas[0]),
        lambda: tui.detail_selected(),
        lambda: tui.show_form(),
        lambda: _open_ver_tabla(tui),
        lambda: tui.show_images(),
        lambda: tui.open_path("/herr-jornada"),
        lambda: tui.open_path("/herr-tablas"),
        lambda: tui.open_caja(),
    ]
    for go in screens:
        go()
        assert audit_shell(tui=tui) == [], tui.view.name


def test_auditoria_lista_vacia():
    from flexablelib_tui.accessibility import audit

    view = ViewList("Vacía", [("a", "A")], rows=[])
    assert audit(view.components(), check_focus=True) == []
