"""Códigos de salida de la CLI."""

from __future__ import annotations

OK = 0
ERROR = 1
USO = 2
VALIDACION = 3
SIN_SESION = 4
PERMISO = 5
NO_ENCONTRADO = 6
CONFLICTO = 7
RED = 8
LIMITE = 9


class CliError(Exception):
    def __init__(self, message: str, code: int = ERROR, *, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.message = message


def code_for_status(status: int) -> int:
    if status in (401, 440):
        return SIN_SESION
    if status == 403:
        return PERMISO
    if status == 404:
        return NO_ENCONTRADO
    if status == 409:
        return CONFLICTO
    if status == 429:
        return LIMITE
    if status == 400:
        return VALIDACION
    if 500 <= status:
        return ERROR
    return ERROR
