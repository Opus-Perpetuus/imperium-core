from __future__ import annotations

import json

import pytest

from imperium_cli.commands import feature_map_test
from imperium_cli.main import build_parser


@pytest.fixture
def fake_api(monkeypatch):
    calls = []

    def api(args, method, path, body=None):
        calls.append((method, path, body))
        if method == "GET":
            return 200, {}, {"ok": True, "tables": [{"table": "subject_pos.ventas", "rows": 2}], "total": 2}
        return 200, {}, {"ok": True, "deleted": [{"table": "subject_pos.ventas", "rows": 2}], "total": 2, "blocked": []}

    monkeypatch.setattr(feature_map_test, "api", api)
    return calls


def test_parser_tiene_resumen_y_purgar():
    parser = build_parser()
    args = parser.parse_args(["feature-map-test", "purgar", "--si"])
    assert args.handler is feature_map_test.purgar and args.yes is True
    assert parser.parse_args(["feature-map-test", "resumen"]).handler is feature_map_test.resumen


def test_resumen_lee_el_conteo(fake_api, capsys):
    args = build_parser().parse_args(["feature-map-test", "resumen", "--json"])
    assert feature_map_test.resumen(args) == 0
    assert fake_api == [("GET", "/api/feature-map-test", None)]
    assert json.loads(capsys.readouterr().out)["total"] == 2


def test_purgar_pide_confirmacion_y_borra(fake_api, capsys):
    args = build_parser().parse_args(["feature-map-test", "purgar", "--si"])
    assert feature_map_test.purgar(args) == 0
    assert fake_api == [("POST", "/api/feature-map-test/purge", {})]
    assert "2 filas de prueba borradas" in capsys.readouterr().out


def test_purgar_dry_run_no_llama(fake_api):
    args = build_parser().parse_args(["feature-map-test", "purgar", "--dry-run"])
    assert feature_map_test.purgar(args) == 0
    assert fake_api == []
