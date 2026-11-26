"""`imperium inventario existencias|kardex|traslado|ajuste|conteo` contra las rutas del núcleo."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ..exits import CliError, NO_ENCONTRADO, VALIDACION
from .common import api, dry_or_confirm, emit, query, rows_of, table_text

LOCATION = "inventory-internal-location"


def _is_id(value: str) -> bool:
    import re

    return bool(re.fullmatch(r"[a-fA-F0-9]{24}|[a-z][a-z0-9-]*_[a-f0-9]{16}|sync(-[a-z0-9]{1,40}){1,12}", value))


def resolve_ref(args, resource: str, value: str | None, label: str) -> str | None:
    """Acepta un id o un código; un código debe coincidir con exactamente un registro."""
    if not value:
        return None
    if _is_id(value):
        return value
    _s, _h, body = api(args, "GET", f"/api/{resource}" + query({"codigo": value, "limite": 2}))
    rows = rows_of(body)
    if len(rows) != 1:
        raise CliError(f"No encontré un único {label} con código «{value}» ({len(rows)} coincidencias).", NO_ENCONTRADO)
    return str(rows[0].get("_id"))


def existencias(args) -> int:
    params: dict[str, Any] = {
        "producto": resolve_ref(args, "products", args.producto, "producto"),
        "ubicacion": resolve_ref(args, LOCATION, args.ubicacion, "ubicación"),
        "termino": args.buscar,
        "limite": args.limite,
    }
    _s, _h, body = api(args, "GET", "/api/inventory-stock-quant" + query(params))
    return emit(body, as_json=args.json, text=table_text(rows_of(body), ["producto", "ubicacion", "lote", "cantidad"]))


def kardex(args) -> int:
    producto = resolve_ref(args, "products", args.producto, "producto")
    path = f"/api/inventory-movement/kardex/{quote(str(producto), safe='')}" + query({"desde": args.desde, "hasta": args.hasta})
    _s, _h, body = api(args, "GET", path)
    rows = rows_of(body)
    movs = (rows[0].get("movimientos") or []) if rows else []
    return emit(body, as_json=args.json, text=table_text([m for m in movs if isinstance(m, dict)]))


def traslado(args) -> int:
    payload: dict[str, Any] = {
        "ubicacion_origen": resolve_ref(args, LOCATION, args.origen, "ubicación origen"),
        "ubicacion_destino": resolve_ref(args, LOCATION, args.destino, "ubicación destino"),
    }
    if not payload["ubicacion_origen"] or not payload["ubicacion_destino"]:
        raise CliError("Faltan --origen y --destino.", VALIDACION)
    if args.almacen_completo:
        payload["desde_almacen"] = True
    else:
        if not args.producto or not args.cantidad or args.cantidad <= 0:
            raise CliError("Faltan --producto y --cantidad (> 0), o usa --almacen-completo.", VALIDACION)
        payload.update(producto=resolve_ref(args, "products", args.producto, "producto"), cantidad=args.cantidad)
        if args.lote:
            payload["lote"] = args.lote
    path = "/api/inventory-movement/traslado"
    if not dry_or_confirm(args, {"metodo": "POST", "ruta": path, "valores": payload}, f"POST {path}", "¿Registrar el traslado?"):
        return 0
    _s, _h, body = api(args, "POST", path, body=payload)
    return emit(body, as_json=args.json, text=str((body or {}).get("message") or "Traslado registrado."))


def ajuste(args) -> int:
    if not args.cantidad or args.cantidad <= 0:
        raise CliError("--cantidad debe ser mayor a cero.", VALIDACION)
    payload = {
        "tipo": "entrada_manual" if args.tipo == "entrada" else "salida_manual",
        "producto": resolve_ref(args, "products", args.producto, "producto"),
        "ubicacion": resolve_ref(args, LOCATION, args.ubicacion, "ubicación"),
        "cantidad": args.cantidad,
        "motivo": (args.motivo or "").strip(),
    }
    if not payload["motivo"]:
        raise CliError("Falta --motivo.", VALIDACION)
    path = "/api/inventory-movement/manual"
    if not dry_or_confirm(args, {"metodo": "POST", "ruta": path, "valores": payload}, f"POST {path}", f"¿Registrar {payload['tipo']}?"):
        return 0
    _s, _h, body = api(args, "POST", path, body={k: v for k, v in payload.items() if v is not None})
    return emit(body, as_json=args.json, text=str((body or {}).get("message") or "Movimiento registrado."))


def conteo(args) -> int:
    base = "/api/inventory-physical-count"
    if args.conteo_cmd == "listar":
        _s, _h, body = api(args, "GET", base + query({"termino": args.buscar, "limite": args.limite}))
        return emit(body, as_json=args.json, text=table_text(rows_of(body), ["_id", "name", "estado", "ubicacion"]))
    if args.conteo_cmd == "ver":
        _s, _h, body = api(args, "GET", f"{base}/{quote(args.id, safe='')}")
        return emit(body, as_json=args.json)
    path = f"{base}/{quote(args.id, safe='')}/aplicar"
    if not dry_or_confirm(args, {"metodo": "POST", "ruta": path}, f"POST {path}", f"¿Aplicar el conteo {args.id}? Ajusta existencias."):
        return 0
    _s, _h, body = api(args, "POST", path, body={})
    return emit(body, as_json=args.json, text=str((body or {}).get("message") or "Conteo aplicado."))
