"""`imperium mcp`: servidor MCP local por stdio (JSON-RPC 2.0, una línea por mensaje).

Usa el perfil activo: el núcleo aplica los permisos de esa cuenta. Solo lectura.
"""

from __future__ import annotations

import json
import sys
from typing import Any, Callable
from urllib.parse import quote

from .. import config
from ..exits import CliError, SIN_SESION
from ..httpc import request_json
from ..version import cli_version
from .common import query

PROTOCOL = "2024-11-05"


def _str(desc: str) -> dict[str, str]:
    return {"type": "string", "description": desc}


TOOLS: list[dict[str, Any]] = [
    {"name": "imperium_estado", "description": "Salud del núcleo y usuario del perfil.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "imperium_recurso_listar", "description": "Lista registros de un recurso visible en /api/meta.",
     "inputSchema": {"type": "object", "properties": {"recurso": _str("Recurso, p. ej. products"), "buscar": _str("Término"), "limite": {"type": "integer"}}, "required": ["recurso"]}},
    {"name": "imperium_recurso_ver", "description": "Un registro por id.",
     "inputSchema": {"type": "object", "properties": {"recurso": _str("Recurso"), "id": _str("Id")}, "required": ["recurso", "id"]}},
    {"name": "imperium_inventario_existencias", "description": "Existencias por producto/ubicación.",
     "inputSchema": {"type": "object", "properties": {"producto": _str("Id de producto"), "ubicacion": _str("Id de ubicación"), "buscar": _str("Término"), "limite": {"type": "integer"}}}},
    {"name": "imperium_ventas_reporte", "description": "Ventas POS por artículo.",
     "inputSchema": {"type": "object", "properties": {"desde": _str("YYYY-MM-DD"), "hasta": _str("YYYY-MM-DD"), "sesion": _str("Id de sesión POS")}}},
    {"name": "imperium_pos_producto", "description": "Busca un producto por código de barras/SKU.",
     "inputSchema": {"type": "object", "properties": {"codigo": _str("Código")}, "required": ["codigo"]}},
]


class Server:
    def __init__(self, profile: dict[str, Any] | None, get: Callable[[str], Any] | None = None):
        self.profile = profile or {}
        self._get = get or self._http_get

    def _http_get(self, path: str) -> Any:
        if not self.profile.get("url") or not self.profile.get("token"):
            raise CliError("El perfil no tiene sesión. Corre: imperium iniciar-sesion", SIN_SESION)
        return request_json(self.profile["url"], "GET", path, token=self.profile["token"])[2]

    def _resource_path(self, recurso: str) -> str:
        return "/api/" + quote(str(recurso).strip("/"), safe="/-_")

    def call(self, name: str, a: dict[str, Any]) -> Any:
        if name == "imperium_estado":
            return {"cli": cli_version(), "url": self.profile.get("url"), "usuario": self._get("/api/auth/")}
        if name == "imperium_recurso_listar":
            return self._get(self._resource_path(a["recurso"]) + query({"termino": a.get("buscar"), "limite": a.get("limite") or 20}))
        if name == "imperium_recurso_ver":
            return self._get(self._resource_path(a["recurso"]) + "/" + quote(str(a["id"]), safe=""))
        if name == "imperium_inventario_existencias":
            return self._get("/api/inventory-stock-quant" + query({"producto": a.get("producto"), "ubicacion": a.get("ubicacion"), "termino": a.get("buscar"), "limite": a.get("limite") or 50}))
        if name == "imperium_ventas_reporte":
            return self._get("/api/pos-tickets/ventas-por-articulo" + query({"desde": a.get("desde"), "hasta": a.get("hasta"), "sesion": a.get("sesion")}))
        if name == "imperium_pos_producto":
            return self._get("/api/products" + query({"codigo": a["codigo"], "limite": 5}))
        raise KeyError(name)

    def handle(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
        if mid is None:
            return None
        if method == "initialize":
            return _ok(mid, {"protocolVersion": params.get("protocolVersion") or PROTOCOL, "capabilities": {"tools": {}},
                             "serverInfo": {"name": "imperium", "version": cli_version()}})
        if method == "ping":
            return _ok(mid, {})
        if method == "tools/list":
            return _ok(mid, {"tools": TOOLS})
        if method == "tools/call":
            name = params.get("name")
            if name not in {t["name"] for t in TOOLS}:
                return _err(mid, -32602, f"Herramienta desconocida: {name}")
            try:
                data = self.call(name, params.get("arguments") or {})
                return _ok(mid, {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}], "isError": False})
            except (CliError, KeyError) as err:
                text = err.message if isinstance(err, CliError) else f"Falta el argumento {err}"
                return _ok(mid, {"content": [{"type": "text", "text": text}], "isError": True})
        return _err(mid, -32601, f"Método no soportado: {method}")

    def serve(self, stdin=None, stdout=None) -> int:
        stdin, stdout = stdin or sys.stdin, stdout or sys.stdout
        for line in stdin:
            if not line.strip():
                continue
            try:
                msg = json.loads(line)
                reply = self.handle(msg) if isinstance(msg, dict) else _err(None, -32600, "Solicitud no válida")
            except json.JSONDecodeError:
                reply = _err(None, -32700, "JSON no válido")
            if reply is not None:
                stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
                stdout.flush()
        return 0


def _ok(mid: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def _err(mid: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}


def mcp(args) -> int:
    data = config.load()
    return Server(config.get_profile(data, getattr(args, "perfil", None))).serve()
