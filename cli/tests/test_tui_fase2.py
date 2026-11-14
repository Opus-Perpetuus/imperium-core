from __future__ import annotations

from imperium_cli.tui.app import Backend, ImperiumTui, audit_shell, menu_sections, run_tui

from .test_fase2 import META


class FakeBackend(Backend):
    def __init__(self):
        super().__init__({"url": "http://n", "token": "icli_X", "user": {"email": "ana@local"}})

    def health(self):
        return {"version": "13.122.12", "db": True}

    def menus(self):
        return [
            {"_id": "r1", "name": "Inventario", "order": 1},
            {"_id": "m1", "name": "Productos", "path": "/products", "parent_id": "r1"},
            {"_id": "r2", "name": "Ventas", "order": 2, "path": "/pedidos"},
        ]

    def meta(self):
        return META["data"][0]["resources"]

    def rows(self, meta, limit=50):
        return [{"codigo": "P1", "name": "Uno", "_id": "a" * 24}]


def test_menu_dinamico_desde_auth_menus():
    opened = []
    sections = menu_sections(FakeBackend().menus(), opened.append)
    assert list(sections) == ["Inventario", "Ventas"]
    sections["Inventario"][0]["action"]()
    assert opened == ["/products"]


def test_audit_con_backend_sin_problemas():
    assert audit_shell(backend=FakeBackend()) == []


def test_atajos_y_paleta_headless(monkeypatch):
    monkeypatch.setenv("NO_COLOR", "1")
    keys = ["ctrl+k", "escape", "/", "escape", "a", "escape", "f2", "f4", "f9", "escape", "f1", "escape", "q"]
    frame = run_tui(profile=None, accesible=True, keys=keys, backend=FakeBackend())
    assert frame is not None and len(str(frame)) > 0


def test_abrir_recurso_y_detalle():
    tui = ImperiumTui(None, FakeBackend())
    tui.open_path("/products")
    assert tui.current["resource"] == "products"
    tui.detail_selected()
    assert tui.shell.pages["Detalle"].content is tui.detail  # dentro de su FocusScroll


def test_term_dumb_lineal(monkeypatch):
    monkeypatch.setenv("TERM", "dumb")
    frame = run_tui(profile=None, keys=["f9", "q"], backend=FakeBackend())
    assert frame is not None
