from __future__ import annotations

from imperium_cli.main import build_parser, main


def test_parser_comandos_en_espanol():
    parser = build_parser()
    args = parser.parse_args(["estado", "--json", "--perfil", "lab"])
    assert args.comando == "estado"
    assert args.json is True
    assert args.perfil == "lab"
    args = parser.parse_args(["apps", "listar"])
    assert args.comando == "apps"
    args = parser.parse_args(["iniciar-sesion", "--url", "http://x", "--usuario", "a"])
    assert args.comando == "iniciar-sesion"
    assert args.url == "http://x"


def test_uso_comando_desconocido():
    assert main(["esto-no-existe"]) == 2
