from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest

from imperium_cli import config, httpc
from imperium_cli.commands import masivo as masivo_mod
from imperium_cli.commands import sesion as sesion_mod
from imperium_cli.exits import PERMISO, SIN_SESION, VALIDACION
from imperium_cli.main import main

META = {
    "data": [
        {
            "resources": [
                {
                    "resource": "products",
                    "path": "/products",
                    "name": "Productos",
                    "permissions": {"read": True, "create": True, "update": True, "delete": True},
                    "fields": [
                        {"name": "name", "label": "Nombre", "type": "string", "required": True},
                        {"name": "codigo", "label": "Código", "type": "string", "required": False},
                        {"name": "precio", "label": "Precio", "type": "number", "required": False},
                    ],
                    "list_columns": [{"name": "codigo", "label": "Código"}, {"name": "name", "label": "Nombre"}],
                },
                {
                    "resource": "user-group",
                    "path": "/user-group",
                    "name": "Grupos",
                    "permissions": {"read": True, "create": False, "update": False, "delete": False},
                    "fields": [{"name": "name", "label": "Nombre", "type": "string", "required": True}],
                    "list_columns": [],
                },
            ]
        }
    ]
}
PID = "a" * 24
LOC1, LOC2 = "b" * 24, "c" * 24


class Fake:
    def __init__(self, routes=None):
        self.calls: list[tuple[str, str, object]] = []
        self.routes = routes or {}

    def __call__(self, base, method, path, **kw):
        self.calls.append((method, path, kw.get("body")))
        for (m, prefix), resp in self.routes.items():
            if m == method and path.startswith(prefix):
                status, body = resp(path, kw.get("body")) if callable(resp) else resp
                return status, {}, json.dumps(body).encode()
        if method == "GET" and path == "/api/meta":
            return 200, {}, json.dumps(META).encode()
        return 200, {}, json.dumps({"data": [], "message": "ok"}).encode()

    def paths(self, method=None):
        return [p for m, p, _ in self.calls if method is None or m == method]


@pytest.fixture
def session(config_home, monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.chdir(tmp_path)
    data = config.load()
    config.upsert_profile(data, "default", {"url": "http://nucleo", "token": "icli_X", "user": {"email": "ana@local"}})
    config.save(data)

    def install(routes=None):
        fake = Fake(routes)
        monkeypatch.setattr(httpc, "request", fake)
        monkeypatch.setattr(sesion_mod, "request", fake)
        return fake

    return install


# ---------- código de dispositivo


def _device_routes(token_responses):
    seq = iter(token_responses)
    return {
        ("POST", "/api/cli/device/code"): (
            200,
            {"device_code": "dev", "user_code": "BCDF-GHJK", "verification_path": "/api/cli/device", "expires_in": 600, "interval": 5},
        ),
        ("POST", "/api/cli/device/token"): lambda p, b: next(seq),
    }


def test_codigo_dispositivo_aprueba_y_guarda_token_sin_contrasena(config_home, monkeypatch, capsys):
    sleeps = []
    monkeypatch.setattr(sesion_mod, "_sleep", sleeps.append)
    fake = Fake(
        _device_routes(
            [
                (400, {"error": "authorization_pending"}),
                (400, {"error": "slow_down", "interval": 10}),
                (200, {"access_token": "icli_NUEVO", "token_prefix": "icli_NUEVO", "id": "t9", "user": {"_id": "u1", "email": "ana@local"}}),
            ]
        )
    )
    monkeypatch.setattr(httpc, "request", fake)
    monkeypatch.setattr(sesion_mod, "request", fake)
    code = main(["iniciar-sesion", "--url", "http://nucleo", "--codigo-dispositivo", "--dispositivo", "lab"])
    assert code == 0
    assert sleeps == [5, 5, 10]
    assert "/api/auth/login" not in fake.paths()
    token_calls = [b for m, p, b in fake.calls if p == "/api/cli/device/token"]
    assert all(b["grant_type"] == "urn:ietf:params:oauth:grant-type:device_code" for b in token_calls)
    err = capsys.readouterr().err
    assert "BCDF-GHJK" in err and "http://nucleo/api/cli/device" in err
    profile = json.loads((config_home / "imperium" / "config.json").read_text())["perfiles"]["default"]
    assert profile["token"] == "icli_NUEVO" and profile["device"] == "lab"


@pytest.mark.parametrize("error", ["expired_token", "access_denied"])
def test_codigo_dispositivo_expirado_o_rechazado_sale_con_4(config_home, monkeypatch, error):
    monkeypatch.setattr(sesion_mod, "_sleep", lambda s: None)
    fake = Fake(_device_routes([(400, {"error": error})]))
    monkeypatch.setattr(httpc, "request", fake)
    monkeypatch.setattr(sesion_mod, "request", fake)
    assert main(["iniciar-sesion", "--url", "http://n", "--codigo-dispositivo"]) == SIN_SESION
    assert not (config_home / "imperium" / "config.json").exists()


def test_sin_terminal_y_sin_credenciales_pide_metodo_explicito(config_home, monkeypatch):
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    assert main(["iniciar-sesion", "--url", "http://n"]) == VALIDACION


def test_token_revocado_sale_con_4_y_no_reintenta_login(session):
    fake = session({("GET", "/api/meta"): (401, {"message": "No estás autenticado"})})
    assert main(["recurso", "products", "listar"]) == SIN_SESION
    assert fake.paths() == ["/api/meta"]


# ---------- recurso


def test_recurso_listar_usa_ruta_de_meta_y_paginacion(session):
    fake = session({("GET", "/api/products"): (200, {"data": [{"codigo": "P1", "name": "Uno"}]})})
    assert main(["recurso", "products", "listar", "--buscar", "uno", "--pagina", "2", "--limite", "10", "--filtro", "activo=true"]) == 0
    assert fake.paths("GET")[-1] == "/api/products?termino=uno&desde=10&limite=10&activo=true"


def test_recurso_crear_valida_y_dry_run_no_escribe(session, capsys):
    fake = session()
    assert main(["recurso", "products", "crear", "--campo", "codigo=P1"]) == VALIDACION
    assert main(["recurso", "products", "crear", "--campo", "zzz=1", "--campo", "name=x"]) == VALIDACION
    assert main(["recurso", "productos", "crear", "--campo", "name=Uno", "--campo", "precio=12.5", "--dry-run", "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["dry_run"] is True and out["valores"] == {"name": "Uno", "precio": 12.5}
    assert fake.paths("POST") == []
    assert main(["recurso", "products", "crear", "--campo", "name=Uno", "--yes"]) == 0
    assert fake.calls[-1] == ("POST", "/api/products", {"name": "Uno"})


def test_recurso_editar_borrar_y_permisos(session):
    fake = session()
    assert main(["recurso", "products", "editar", PID, "--campo", "precio=3", "--yes"]) == 0
    assert fake.calls[-1] == ("PATCH", f"/api/products/{PID}", {"precio": 3})
    assert main(["recurso", "products", "borrar", PID, "--yes"]) == 0
    assert fake.calls[-1][:2] == ("DELETE", f"/api/products/id/{PID}")
    assert main(["recurso", "user-group", "borrar", "g1", "--yes"]) == PERMISO
    assert main(["recurso", "no-existe", "listar"]) == 6


# ---------- inventario, ventas y POS


def test_inventario_rutas_reales(session):
    fake = session({("GET", "/api/inventory-internal-location"): lambda p, b: (200, {"data": [{"_id": LOC2 if "A-2" in p else LOC1}]})})
    assert main(["inventario", "existencias", "--producto", PID]) == 0
    assert fake.paths("GET")[-1] == f"/api/inventory-stock-quant?producto={PID}&limite=50"
    assert main(["inventario", "kardex", PID, "--desde", "2026-01-01"]) == 0
    assert fake.paths("GET")[-1] == f"/api/inventory-movement/kardex/{PID}?desde=2026-01-01"
    assert main(["inventario", "traslado", "--producto", PID, "--origen", "A-1", "--destino", "A-2", "--cantidad", "3", "--yes"]) == 0
    assert fake.calls[-1] == (
        "POST",
        "/api/inventory-movement/traslado",
        {"ubicacion_origen": LOC1, "ubicacion_destino": LOC2, "producto": PID, "cantidad": 3.0},
    )
    before = len(fake.paths("POST"))
    assert main(["inventario", "ajuste", "--tipo", "salida", "--producto", PID, "--cantidad", "2", "--motivo", "merma", "--dry-run"]) == 0
    assert len(fake.paths("POST")) == before
    assert main(["inventario", "ajuste", "--tipo", "entrada", "--producto", PID, "--cantidad", "2", "--motivo", "compra", "--yes"]) == 0
    assert fake.calls[-1] == ("POST", "/api/inventory-movement/manual", {"tipo": "entrada_manual", "producto": PID, "cantidad": 2.0, "motivo": "compra"})
    assert main(["inventario", "conteo", "aplicar", "c1", "--yes"]) == 0
    assert fake.calls[-1][:2] == ("POST", "/api/inventory-physical-count/c1/aplicar")


def test_ventas_y_pos_rutas_reales(session):
    fake = session()
    assert main(["ventas", "pedidos", "listar", "--estado", "surtido"]) == 0
    assert fake.paths()[-1] == "/api/pedidos?limite=50&estado=surtido"
    assert main(["ventas", "pedidos", "ver", "p1"]) == 0
    assert fake.paths()[-1] == "/api/pedidos/p1"
    assert main(["ventas", "reporte", "--desde", "2026-11-01", "--hasta", "2026-11-13"]) == 0
    assert fake.paths()[-1] == "/api/pos-tickets/ventas-por-articulo?desde=2026-11-01&hasta=2026-11-13"
    assert main(["pos", "sesiones", "listar", "--abiertas"]) == 0
    assert fake.paths()[-1] == "/api/pos-session?status=abierta&limite=50"
    assert main(["pos", "sesiones", "cerrar", "s1", "s2", "--motivo", "fin de turno", "--dry-run"]) == 0
    assert fake.calls[-1] == ("POST", "/api/pos-session/bulk-close", {"ids": ["s1", "s2"], "reason": "fin de turno", "force": False, "dry_run": True})
    assert main(["pos", "sesiones", "cerrar", "s1", "--motivo", "fin de turno", "--yes"]) == 0
    assert "dry_run" not in fake.calls[-1][2]
    assert main(["pos", "reimprimir", "--folio", "V9", "--tipo", "remision", "--yes"]) == 0
    assert fake.calls[-1] == ("POST", "/api/pos-tickets/reimpresion", {"tipo": "remision", "folio": "V9"})


# ---------- masivo


def _csv(path: Path, rows: list[dict]) -> Path:
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    return path


def test_masivo_dry_run_por_defecto_muestra_plan(session, tmp_path, capsys, monkeypatch):
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    fake = session()
    f = _csv(tmp_path / "p.csv", [{"Nombre": "Uno", "precio": "1"}, {"Nombre": "", "precio": "x"}])
    assert main(["masivo", "importar", "products", "--desde", str(f), "--mapeo", "Nombre=name", "--json"]) == 0
    plan = json.loads(capsys.readouterr().out)
    assert plan["dry_run"] is True and plan["total"] == 2 and plan["validas"] == 1 and plan["con_errores"] == 1
    assert fake.paths("PUT") == []


def test_masivo_importar_por_lotes_con_reporte(session, tmp_path):
    def batch(path, body):
        return 200, {"success": [{"row": i + 1, "_id": f"id{i}", "operation": "create"} for i in range(len(body))], "errors": []}

    fake = session({("PUT", "/api/products/batch"): batch})
    f = _csv(tmp_path / "p.csv", [{"name": f"P{i}"} for i in range(5)])
    report = tmp_path / "r.csv"
    assert main(["masivo", "importar", "products", "--desde", str(f), "--lote", "2", "--yes", "--reporte", str(report)]) == 0
    assert len(fake.paths("PUT")) == 3
    rows = list(csv.DictReader(report.open()))
    assert [r["estado"] for r in rows] == ["creado"] * 5


def test_masivo_borrar_respalda_antes_y_aborta_si_falla(session, tmp_path, monkeypatch):
    monkeypatch.setattr(masivo_mod, "_sleep", lambda s: None)
    f = _csv(tmp_path / "b.csv", [{"_id": PID}, {"_id": "d" * 24}])
    fake = session(
        {
            ("POST", "/api/db-admin/backups"): (202, {"data": [{"id": "respaldo-1", "status": "running"}]}),
            ("GET", "/api/db-admin/tasks/respaldo-1"): (200, {"data": [{"id": "respaldo-1", "status": "error", "error": "sin disco"}]}),
        }
    )
    assert main(["masivo", "borrar", "products", "--desde", str(f), "--yes"]) == 1
    assert fake.paths("DELETE") == []

    states = iter([{"status": "running"}, {"status": "success", "result": {"id": "bk-20261113"}}])
    fake = session(
        {
            ("POST", "/api/db-admin/backups"): (202, {"data": [{"id": "respaldo-2", "status": "running"}]}),
            ("GET", "/api/db-admin/tasks/respaldo-2"): lambda p, b: (200, {"data": [next(states)]}),
        }
    )
    assert main(["masivo", "borrar", "products", "--desde", str(f), "--yes", "--json"]) == 0
    order = [(m, p) for m, p, _ in fake.calls if m in ("POST", "DELETE")]
    assert order[0] == ("POST", "/api/db-admin/backups")
    assert [p for m, p in order[1:]] == [f"/api/products/id/{PID}", f"/api/products/id/{'d' * 24}"]


def test_masivo_continuar_reanuda_donde_se_corto(session, tmp_path, capsys):
    calls = {"n": 0}

    def flaky(path, body):
        calls["n"] += 1
        if calls["n"] == 2:
            return 503, {"message": "caído"}
        return 200, {"success": [{"row": i + 1, "_id": "x", "operation": "update"} for i in range(len(body))]}

    fake = session({("PUT", "/api/products/batch"): flaky})
    f = _csv(tmp_path / "e.csv", [{"_id": f"{i:024x}", "precio": str(i)} for i in range(4)])
    assert main(["masivo", "editar", "products", "--desde", str(f), "--lote", "2", "--yes"]) == 1
    job = next((tmp_path / "state" / "imperium" / "masivo").glob("*.json")).stem
    state = json.loads((tmp_path / "state" / "imperium" / "masivo" / f"{job}.json").read_text())
    assert state["siguiente"] == 2
    assert "batch_match_field=_id" in fake.paths("PUT")[0]
    capsys.readouterr()
    assert main(["masivo", "--continuar", job, "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["procesadas"] == 4 and out["con_error"] == 0
    assert len(fake.paths("PUT")) == 3

    f.write_text("_id,precio\nzzz,1\n")
    assert main(["masivo", "--continuar", job]) == VALIDACION


def test_masivo_lee_xlsx(tmp_path):
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.append(["name", "precio"])
    ws.append(["Uno", 3])
    ws.append([None, None])
    wb.save(tmp_path / "p.xlsx")
    assert masivo_mod.read_rows(tmp_path / "p.xlsx") == [{"name": "Uno", "precio": 3}]
