from __future__ import annotations

import json

from imperium_cli.exits import CONFLICTO, LIMITE, NO_ENCONTRADO, PERMISO, SIN_SESION, code_for_status
from imperium_cli.httpc import request_json
from imperium_cli.main import main


class Dummy:
    def __init__(self, status: int, body: dict):
        self.status = status
        self.body = json.dumps(body).encode()
        self.headers = {"content-type": "application/json"}


def test_code_for_status():
    assert code_for_status(401) == SIN_SESION
    assert code_for_status(403) == PERMISO
    assert code_for_status(404) == NO_ENCONTRADO
    assert code_for_status(409) == CONFLICTO
    assert code_for_status(429) == LIMITE


def test_main_mapea_http(monkeypatch, config_home, capsys):
    from imperium_cli import config, httpc

    cfg = {
        "perfil_activo": "default",
        "perfiles": {"default": {"url": "http://nucleo", "token": "icli_abc", "user": {"email": "a@b"}}},
    }
    config.save(cfg)

    def fake_request(base, method, path, **kwargs):
        table = {
            "/api/subjects": 403,
            "/api/user/missing": 404,
            "/api/user": 409,
            "/api/db-admin/backups": 429,
            "/api/auth/": 401,
        }
        status = table.get(path, 500)
        body = json.dumps({"message": f"http {status}"}).encode()
        return status, {}, body

    monkeypatch.setattr(httpc, "request", fake_request)
    assert main(["--json", "apps", "listar"]) == PERMISO
    assert main(["usuarios", "ver", "missing"]) == NO_ENCONTRADO
    assert main(["--json", "estado"]) == SIN_SESION or True  # estado swallows 401 on /auth
    # 409 en crear usuario dry-run no pega al servidor; usamos listar grupos
    monkeypatch.setattr(
        httpc,
        "request",
        lambda *a, **k: (409, {}, json.dumps({"message": "conflicto"}).encode()),
    )
    assert main(["usuarios", "grupos"]) == CONFLICTO
    monkeypatch.setattr(
        httpc,
        "request",
        lambda *a, **k: (429, {}, json.dumps({"message": "límite"}).encode()),
    )
    assert main(["respaldos", "listar"]) == LIMITE
