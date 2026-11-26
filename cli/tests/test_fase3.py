from __future__ import annotations

import io
import json
import os
import stat
import sys
import types
from pathlib import Path

import pytest

from imperium_cli import config
from imperium_cli.commands import caja, mcp, ssh_shell
from imperium_cli.exits import CliError
from imperium_cli.main import build_parser, main

PRODUCTOS = [
    {"_id": "p1", "name": "Codo", "codigo_barras": "7501", "precio_venta": 12.5, "existencia": 9},
    {"_id": "p2", "name": "Tubo", "sku": "TUB-1", "price": 30},
]


@pytest.fixture
def fake_api(monkeypatch):
    calls = []

    def api(args, method, path, body=None):
        calls.append((method, path, body))
        if path.startswith("/api/products"):
            code = path.split("=", 1)[1].split("&", 1)[0]
            rows = [p for p in PRODUCTOS if code in (p.get("codigo_barras"), p.get("sku"))]
            return 200, {}, {"data": rows}
        if path.startswith("/api/pos-session"):
            return 200, {}, {"data": [{"_id": "ses-1"}]}
        if path == "/api/pos-tickets":
            return 200, {}, {"data": {"_id": "t1", "ticket_sequence": "V9", **body}}
        return 200, {}, {"ok": True}

    monkeypatch.setattr(caja, "api", api)
    return calls


def _args(argv):
    return build_parser().parse_args(argv)


# ----- caja
def test_parse_item_cantidades():
    assert caja.parse_item("7501") == ("7501", 1.0)
    assert caja.parse_item("3*7501") == ("7501", 3.0)
    assert caja.parse_item("TUB-1x2") == ("tub-1", 2.0)
    with pytest.raises(CliError):
        caja.parse_item("0*7501")


def test_caja_no_interactiva_registra_y_reimprime(fake_api, capsys):
    args = _args(["pos", "caja", "--codigo", "7501", "--item", "2*TUB-1", "--efectivo", "100", "--yes", "--reimprimir", "--json"])
    assert caja.caja(args) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["total"] == 72.5 and out["cambio"] == 27.5
    post = [c for c in fake_api if c[0] == "POST" and c[1] == "/api/pos-tickets"][0][2]
    assert post["ticket_type"] == "VENTA" and post["pos_session"] == "ses-1"
    assert post["items"][1] == {"item_id": "p2", "quantity": 2.0, "unit_price": 30.0, "total": 60.0}
    assert any(c[1] == "/api/pos-tickets/reimpresion" for c in fake_api)


def test_caja_dry_run_no_escribe(fake_api, capsys):
    args = _args(["pos", "caja", "--codigo", "7501", "--dry-run", "--json"])
    caja.caja(args)
    assert json.loads(capsys.readouterr().out)["dry_run"] is True
    assert not [c for c in fake_api if c[0] == "POST"]


def test_caja_escaner_stdin(fake_api, capsys):
    args = _args(["pos", "caja", "--pago", "tarjeta", "--sesion", "S2", "--yes", "--json"])
    scanner = io.StringIO("7501\n7501\nnoexiste\n2*TUB-1\n-\n\n")
    caja.caja(args, stream=scanner)
    out = json.loads(capsys.readouterr().out)
    assert out["total"] == 25.0 and out["ticket"]["pos_session"] == "S2"
    assert out["ticket"]["card_amount"] == 25.0


def test_caja_efectivo_insuficiente(fake_api):
    with pytest.raises(CliError):
        caja.caja(_args(["pos", "caja", "--codigo", "7501", "--efectivo", "1", "--yes"]))


# ----- perfiles, keyring, pipx
class FakeKeyring:
    def __init__(self):
        self.store = {}

    def set_password(self, s, k, v):
        self.store[(s, k)] = v

    def get_password(self, s, k):
        return self.store.get((s, k))

    def delete_password(self, s, k):
        self.store.pop((s, k), None)


def test_perfiles_multi_instancia(config_home, monkeypatch, capsys):
    monkeypatch.setenv("IMPERIUM_KEYRING", "0")
    assert main(["perfiles", "agregar", "--nombre", "a", "--url", "https://a.test/", "--usar"]) == 0
    assert main(["perfiles", "agregar", "--nombre", "b", "--url", "https://b.test"]) == 0
    assert main(["perfiles", "usar", "b"]) == 0
    data = config.load()
    assert data["perfil_activo"] == "b" and set(data["perfiles"]) == {"a", "b"}
    assert main(["perfiles", "eliminar", "b"]) == 0
    assert config.load()["perfil_activo"] == "a"
    path = config.config_path()
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


def test_keyring_guarda_token_fuera_del_archivo(config_home, monkeypatch):
    kr = FakeKeyring()
    monkeypatch.delenv("IMPERIUM_KEYRING", raising=False)
    monkeypatch.setitem(sys.modules, "keyring", types.SimpleNamespace(**{n: getattr(kr, n) for n in ("set_password", "get_password", "delete_password")}))
    data = config.load()
    config.upsert_profile(data, "x", {"url": "https://x.test", "token": "secreto"})
    path = config.save(data)
    assert "secreto" not in path.read_text()
    assert config.get_profile(config.load(), "x")["token"] == "secreto"
    data = config.load()
    config.delete_profile(data, "x")
    config.save(data)
    assert kr.store == {}


def test_pyproject_alias_imp():
    text = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text()
    assert 'imp = "imperium_cli.main:main"' in text and 'imperium = "imperium_cli.main:main"' in text


# ----- MCP
def test_mcp_initialize_list_call():
    paths = []
    server = mcp.Server({"url": "https://x", "token": "t"}, get=lambda p: paths.append(p) or {"data": [{"_id": 1}]})
    lines = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "imperium_recurso_listar", "arguments": {"recurso": "products", "buscar": "codo"}}},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "rm_rf", "arguments": {}}},
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "imperium_recurso_ver", "arguments": {"recurso": "products"}}},
    ]
    out = io.StringIO()
    server.serve(io.StringIO("\n".join(json.dumps(l) for l in lines) + "\nno-json\n"), out)
    replies = [json.loads(l) for l in out.getvalue().splitlines()]
    assert [r.get("id") for r in replies] == [1, 2, 3, 4, 5, None]
    assert replies[0]["result"]["protocolVersion"] == "2025-03-26"
    names = {t["name"] for t in replies[1]["result"]["tools"]}
    assert {"imperium_estado", "imperium_recurso_listar", "imperium_recurso_ver", "imperium_inventario_existencias", "imperium_ventas_reporte"} <= names
    assert replies[2]["result"]["isError"] is False and paths[0].startswith("/api/products?")
    assert replies[3]["error"]["code"] == -32602
    assert replies[4]["result"]["isError"] is True
    assert replies[5]["error"]["code"] == -32700


def test_mcp_sin_sesion_es_error_de_herramienta():
    reply = mcp.Server(None).handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "imperium_estado"}})
    assert reply["result"]["isError"] is True


# ----- ssh-shell
@pytest.mark.parametrize("cmd", ["bash", "estado; rm -rf /", "estado && id", "$(id)", "doctor", "actualizar", "logs", "perfiles listar",
                                 "mcp", "ssh-shell", "masivo borrar products --desde /etc/passwd", "estado --perfil otro", "'sin cerrar"])
def test_ssh_rechaza(cmd):
    with pytest.raises(CliError):
        ssh_shell.parse(cmd)


def test_ssh_permite_y_vacio_abre_tui():
    assert ssh_shell.parse("") is None
    assert ssh_shell.parse("imperium --json") is None
    assert ssh_shell.parse("imperium estado --json") == ["estado", "--json"]
    assert ssh_shell.parse('pos caja --codigo "7501"') == ["pos", "caja", "--codigo", "7501"]


def test_ssh_shell_ejecuta_lista_blanca(monkeypatch, capsys):
    monkeypatch.setenv("SSH_ORIGINAL_COMMAND", "doctor")
    assert main(["ssh-shell"]) != 0
    assert "no permitido" in capsys.readouterr().err


# ----- TUI
def test_tui_caja_y_restringido(monkeypatch):
    from imperium_cli.tui.app import ImperiumTui, audit_shell

    assert audit_shell(profile=None) == []
    tui = ImperiumTui(None)
    assert "Caja" in tui.shell.pages and "f6" in tui.bindings()
    monkeypatch.setenv("IMPERIUM_RESTRINGIDO", "1")
    tui = ImperiumTui(None)
    assert "Masivo" not in tui.shell.pages and "f9" not in tui.bindings()
    assert audit_shell(profile=None) == []


def test_tui_letras_no_se_roban_al_escribir():
    from imperium_cli.tui.app import ImperiumTui

    tui = ImperiumTui(None)
    tui.app = types.SimpleNamespace(focused=tui.caja_input, focus=lambda c: None)
    assert tui.bindings()["a"][0]() is False
    tui.app = types.SimpleNamespace(focused=None, focus=lambda c: None)
    assert tui.bindings()["a"][0]() is not False
