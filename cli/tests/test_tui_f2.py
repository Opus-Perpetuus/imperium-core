"""F2 abre el alta de la vista activa, no la del primer recurso (`metas[0]`, permisos)."""

from __future__ import annotations

import types

from flexablelib_components import Form

from imperium_cli.tui.app import ImperiumTui

from .tui_fixtures import HerrBackend


def _tui():
    tui = ImperiumTui(None, HerrBackend())
    avisos: list[str] = []
    tui.app = types.SimpleNamespace(focused=None, focus=lambda c: None, layers=[], notify=lambda m, kind="info": avisos.append(m), announce=lambda m: None)
    return tui, avisos


def test_f2_abre_alta_del_recurso_activo():
    tui, _ = _tui()
    tui.open_meta(tui.metas[0])
    tui.bindings()["f2"][0]()
    assert isinstance(tui.form, Form) and tui.form.title == "Alta de Productos"


def test_f2_en_vista_sin_alta_avisa_y_no_abre_otro_recurso():
    tui, avisos = _tui()
    tui.open_path("/herr-jornada")
    antes = tui.view
    tui.bindings()["f2"][0]()
    assert tui.view is antes and avisos == ["Esta vista no permite crear desde la terminal."]
