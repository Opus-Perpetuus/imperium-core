from __future__ import annotations

import json

from imperium_cli import httpc
from imperium_cli.exits import LIMITE, SIN_SESION
from imperium_cli.main import main


def test_iniciar_sesion_un_solo_intento(monkeypatch, config_home):
    calls: list[tuple[str, str]] = []

    def fake_request(base, method, path, **kwargs):
        calls.append((method, path))
        if path == "/api/auth/login":
            return 401, {}, json.dumps({"message": "Usuario o contraseña no válido"}).encode()
        raise AssertionError(f"no debería llamarse {path}")

    monkeypatch.setattr(httpc, "request", fake_request)
    monkeypatch.setattr("imperium_cli.commands.sesion.request", fake_request)
    code = main(
        [
            "iniciar-sesion",
            "--url",
            "http://nucleo",
            "--usuario",
            "ana@local",
            "--contrasena",
            "mala",
            "--dispositivo",
            "prueba",
        ]
    )
    assert code == SIN_SESION
    assert calls == [("POST", "/api/auth/login")]


def test_iniciar_sesion_429_no_reintenta(monkeypatch, config_home):
    calls = []

    def fake_request(base, method, path, **kwargs):
        calls.append(path)
        return 429, {}, json.dumps({"message": "Demasiados intentos"}).encode()

    monkeypatch.setattr(httpc, "request", fake_request)
    monkeypatch.setattr("imperium_cli.commands.sesion.request", fake_request)
    assert main(["iniciar-sesion", "--url", "http://n", "--usuario", "a", "--contrasena", "b"]) == LIMITE
    assert calls == ["/api/auth/login"]


def test_iniciar_sesion_guarda_token_y_no_cookie(monkeypatch, config_home):
    def fake_request(base, method, path, **kwargs):
        if path == "/api/auth/login":
            assert kwargs.get("body") == {"email": "ana@local", "password": "secreta"}
            # un solo intento
            return (
                200,
                {"set-cookie": "connect.sid=abc123; Path=/; HttpOnly"},
                json.dumps({"user": {"_id": "u1", "name": "Ana", "email": "ana@local"}}).encode(),
            )
        if path == "/api/cli/token/generate":
            assert kwargs.get("cookie") == "connect.sid=abc123"
            assert "token" not in (kwargs or {}) or not kwargs.get("token")
            return (
                200,
                {},
                json.dumps({"data": [{"token": "icli_SUPERSECRETO", "token_prefix": "icli_SUPER", "id": "t1"}]}).encode(),
            )
        raise AssertionError(path)

    monkeypatch.setattr(httpc, "request", fake_request)
    monkeypatch.setattr("imperium_cli.commands.sesion.request", fake_request)
    assert (
        main(
            [
                "--json",
                "iniciar-sesion",
                "--url",
                "http://nucleo",
                "--usuario",
                "ana@local",
                "--contrasena",
                "secreta",
                "--dispositivo",
                "lab",
            ]
        )
        == 0
    )
    saved = json.loads((config_home / "imperium" / "config.json").read_text())
    profile = saved["perfiles"]["default"]
    assert profile["token"] == "icli_SUPERSECRETO"
    assert profile["url"] == "http://nucleo"
    assert "cookie" not in profile
    assert profile["user"]["email"] == "ana@local"
    text = (config_home / "imperium" / "config.json").read_text()
    assert "connect.sid" not in text
