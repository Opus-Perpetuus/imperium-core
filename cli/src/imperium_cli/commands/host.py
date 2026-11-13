"""Comandos de host: el wrapper del servidor los ejecuta; dentro del contenedor se explica."""

from __future__ import annotations

import os

from ..exits import CliError, USO
from .common import emit

HOST_HINT = (
    "Este comando se ejecuta en el servidor (usuario root o deploy) "
    "con el wrapper /usr/local/bin/imperium, no dentro del contenedor cli."
)


def _inside_container() -> bool:
    if os.environ.get("IMPERIUM_HOST_WRAPPER") == "1":
        return False
    return os.path.exists("/.dockerenv") or os.environ.get("IMPERIUM_CLI_CONTAINER") == "1"


def require_host(args, nombre: str) -> int:
    if _inside_container():
        raise CliError(
            f"«{nombre}» es una operación de host. {HOST_HINT}",
            USO,
        )
    # Si el wrapper no nos invocó, igual avisamos: no ejecutamos update-v13 desde aquí.
    raise CliError(
        f"«{nombre}» lo corre el wrapper del host (root o deploy): {HOST_HINT}",
        USO,
    )


def doctor(args) -> int:
    return require_host(args, "doctor")


def actualizar(args) -> int:
    return require_host(args, "actualizar")


def logs(args) -> int:
    return require_host(args, "logs")
