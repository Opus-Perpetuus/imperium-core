"""`imperium ssh-shell`: entrada para `ForceCommand` de sshd.

Solo corre subcomandos de la lista blanca, sin shell. Vacío abre la TUI restringida.
"""

from __future__ import annotations

import os
import shlex
import sys

from ..exits import CliError, PERMISO, USO

PERMITIDOS = {"estado", "version", "apps", "respaldos", "usuarios", "instancia", "recurso", "inventario", "ventas", "pos", "cerrar-sesion", "iniciar-sesion"}
GLOBALES = {"--json", "--accesible"}
PROHIBIDOS = {"masivo", "ssh-shell", "mcp", "doctor", "actualizar", "logs", "perfiles"}
METACARACTERES = set(";|&`$<>\n\\")


def parse(original: str | None) -> list[str] | None:
    """None = TUI restringida; lista = argv validado para `imperium`."""
    text = (original or "").strip()
    if not text:
        return None
    if any(c in METACARACTERES for c in text):
        raise CliError("Comando no permitido por SSH.", PERMISO)
    try:
        argv = shlex.split(text)
    except ValueError as err:
        raise CliError("Comando SSH mal formado.", USO) from err
    if argv and argv[0] in ("imperium", "imp"):
        argv = argv[1:]
    rest = [a for a in argv if a not in GLOBALES]
    if not rest:
        return None
    if rest[0] in PROHIBIDOS or rest[0] not in PERMITIDOS:
        raise CliError(f"Subcomando no permitido por SSH: {rest[0]}", PERMISO)
    if any(a.startswith("--perfil") or a.startswith("--salida") or a.startswith("--config") or a.startswith("--reporte") for a in argv):
        raise CliError("Opción no permitida por SSH.", PERMISO)
    return argv


def ssh_shell(args) -> int:
    from ..main import main

    try:
        argv = parse(os.environ.get("SSH_ORIGINAL_COMMAND"))
    except CliError as err:
        sys.stderr.write(err.message + "\n")
        return int(err.code)
    os.environ["IMPERIUM_RESTRINGIDO"] = "1"
    return main(argv or [])
