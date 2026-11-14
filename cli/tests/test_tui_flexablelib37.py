"""Piezas de flexablelib 3.7 en la TUI: firma, cronómetro, escáner que
conserva el código, subtabla dentro del formulario, catálogo con fotos con
headers, «Ver tabla» como VStack que llena el alto y marcas de foco."""

from __future__ import annotations

import datetime as dt
import re

import pytest
from flexablelib_components import CatalogGrid, EditableTable, Form, SignatureInput, Stopwatch, VStack

from imperium_cli.tui import fields as F
from imperium_cli.tui.app import ImperiumTui, audit_shell, run_tui
from imperium_cli.tui.nox import NoxRenderer, _jsonable

from .tui_fixtures import HerrBackend

ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")


@pytest.fixture(autouse=True)
def _plain(monkeypatch):
    monkeypatch.setenv("NO_COLOR", "1")
    monkeypatch.setenv("TERM", "xterm-256color")
    monkeypatch.setenv("IMPERIUM_IMAGEN", "braille")


class Host:
    def __init__(self):
        self.sent = []

    def submit(self, action, values):
        self.sent.append((action, values))

    def image_request(self, src):
        return ("https://nucleo.mx" + src, {"Authorization": "Bearer t"}) if src.startswith("/") else None

    def __getattr__(self, name):
        return lambda *a, **k: None


def test_firma_se_dibuja_y_se_manda_como_png():
    sig = F.input_for("input-signature", {"name": "firma", "label": "Firma"})
    assert isinstance(sig, SignatureInput)
    for key in ("space", "right", "right", "down"):
        sig.handle_key(key)
    assert not sig.is_empty()
    payload = F.form_payload(Form([sig]), {"firma": sig.value})
    assert payload["firma"].startswith("data:image/png;base64,")
    vacia = F.input_for("input-signature", {"name": "firma", "label": "Firma", "value": "/api/files/f.png"})
    assert vacia.current == "/api/files/f.png"
    assert "firma" not in F.form_payload(Form([vacia]), {"firma": vacia.value})  # sin trazos no pisa la guardada


def test_cronometro_en_segundos():
    clock = [100.0]
    sw = Stopwatch(label="T", name="t", clock=lambda: clock[0])
    sw.start()
    clock[0] = 102.5
    sw.stop()
    assert F.form_payload(Form([sw]), {"t": sw.value})["t"] == 2.5
    assert isinstance(F.input_for("input-stopwatch", {"name": "t", "value": 90}), Stopwatch)
    assert F.input_for("input-stopwatch", {"name": "t", "value": 90}).value == dt.timedelta(seconds=90)
    assert _jsonable(dt.timedelta(seconds=3)) == 3.0


def test_escaner_conserva_el_codigo():
    scan = F.input_for("input-scanner", {"name": "s"})
    scan.text = "750100"
    scan.submit()
    assert scan.value == "750100" and scan.last_code == "750100"


def test_subtabla_y_firma_entran_al_formulario_nox():
    desc = {"page": {"component": "nox.form", "props": {"method": "POST", "action": "api://x/guardar"}, "children": [
        {"component": "nox.input-text", "props": {"name": "a", "label": "A", "value": "uno"}},
        {"component": "nox.input-subtable", "props": {"name": "gastos", "label": "Gastos", "columns": [{"key": "c", "label": "C"}], "value": [{"c": "Gas"}]}},
        {"component": "nox.stopwatch", "props": {"name": "dur", "label": "Duración"}},
    ]}}
    host = Host()
    form = NoxRenderer(host).render(desc).forms[0]
    assert any(isinstance(n, EditableTable) for n in form.form_nodes())
    form.submit()
    _action, values = host.sent[-1]
    assert values["a"] == "uno" and values["gastos"] == [{"c": "Gas"}] and values["dur"] == 0.0


def test_catalogo_con_fotos_y_headers():
    desc = {"page": {"component": "nox.catalog-grid", "props": {"items": [
        {"title": "Taladro", "image_url": "/api/files/t.png", "price": "$10"},
        {"title": "Llave", "image_url": "/api/files/l.png"},
    ]}}}
    out = NoxRenderer(Host()).render(desc)
    grid = out.component
    assert isinstance(grid, CatalogGrid)
    assert grid.image_headers == {"Authorization": "Bearer t"}
    assert [i["image"] for i in grid.items] == ["https://nucleo.mx/api/files/t.png", "https://nucleo.mx/api/files/l.png"]
    assert grid.items[0]["image_alt"] == "Foto de Taladro"


def test_catalogo_de_otro_origen_no_lleva_token():
    desc = {"page": {"component": "nox.catalog-grid", "props": {"items": [
        {"title": "A", "image_url": "/api/files/a.png"},
        {"title": "B", "image_url": "https://cdn.otro.mx/b.png"},
    ]}}}
    grid = NoxRenderer(Host()).render(desc).component
    assert grid.image_headers is None  # mezcla de orígenes: cada foto con lo suyo


@pytest.mark.parametrize("h", [16, 24, 40])
def test_ver_tabla_es_vstack_que_llena_el_alto(h):
    out: list = []
    run_tui(profile=None, keys=[], backend=HerrBackend(), size=(120, h), tui_out=out)
    tui = out[0]
    tui.open_page("herramientas", "herramientas.herr-tabla", "id=tabla_1")
    lines = ANSI.sub("", tui.app.run(keys=["tab"], size=(120, h))).split("\n")
    assert len(lines) == h and any("Página" in line or "Ana 1" in line for line in lines)
    assert isinstance(tui.shell.content, VStack)
    table = tui.view.lists[0].table
    assert table.visible_rows >= 1
    if h >= 40:
        assert table.visible_rows > 14  # con alto, la tabla crece (fill=True)
    assert audit_shell(tui=tui) == []


def test_formulario_crud_usa_todas_las_entradas_nuevas():
    tui = ImperiumTui(None, HerrBackend())
    tui.open_meta(tui.metas[0])
    tui.show_form()
    kinds = {type(f).__name__ for f in tui.form.fields()}
    assert "ImageFileInput" in kinds
    assert isinstance(tui.caja_input, F.ScanInput) and tui.caja_input.keep_value is False
