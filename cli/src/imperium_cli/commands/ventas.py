"""`imperium ventas …` y `imperium pos …` contra las rutas de pedidos y POS del núcleo."""

from __future__ import annotations

from urllib.parse import quote

from ..exits import CliError, VALIDACION
from .common import api, dry_or_confirm, emit, query, rows_of, table_text


def pedidos(args) -> int:
    if args.pedidos_cmd == "ver":
        _s, _h, body = api(args, "GET", f"/api/pedidos/{quote(args.id, safe='')}")
        return emit(body, as_json=args.json)
    params = {"termino": args.buscar, "limite": args.limite, "estado": args.estado}
    _s, _h, body = api(args, "GET", "/api/pedidos" + query(params))
    return emit(body, as_json=args.json, text=table_text(rows_of(body), ["folio", "cliente", "estado", "total"]))


def reporte(args) -> int:
    params = {"desde": args.desde, "hasta": args.hasta, "sesion": args.sesion}
    _s, _h, body = api(args, "GET", "/api/pos-tickets/ventas-por-articulo" + query(params))
    rows = rows_of(body)
    items = (rows[0].get("articulos") or []) if rows else []
    return emit(body, as_json=args.json, text=table_text([i for i in items if isinstance(i, dict)]))


def sesiones(args) -> int:
    if args.sesiones_cmd == "listar":
        params = {"status": "abierta" if args.abiertas else None, "limite": args.limite}
        _s, _h, body = api(args, "GET", "/api/pos-session" + query(params))
        return emit(body, as_json=args.json, text=table_text(rows_of(body), ["_id", "name", "status", "user"]))
    if not args.ids:
        raise CliError("Indica los ids de las sesiones a cerrar.", VALIDACION)
    payload = {"ids": args.ids, "reason": args.motivo, "force": bool(args.forzar)}
    if args.dry_run:
        # El núcleo ya sabe decir qué cerraría: le pedimos su plan sin cerrar nada.
        _s, _h, body = api(args, "POST", "/api/pos-session/bulk-close", body={**payload, "dry_run": True})
        return emit(body, as_json=args.json, text="[dry-run] " + str((body or {}).get("message") or "Plan de cierre."))
    if not args.motivo:
        raise CliError("Falta --motivo.", VALIDACION)
    from .common import confirm

    confirm(args, f"¿Cerrar {len(args.ids)} sesión(es) POS?")
    _s, _h, body = api(args, "POST", "/api/pos-session/bulk-close", body=payload)
    return emit(body, as_json=args.json, text=str((body or {}).get("message") or "Sesiones cerradas."))


def reimprimir(args) -> int:
    if not args.folio and not args.id:
        raise CliError("Indica --folio o --id del ticket.", VALIDACION)
    payload = {"tipo": args.tipo, **({"id": args.id} if args.id else {"folio": args.folio})}
    path = "/api/pos-tickets/reimpresion"
    if not dry_or_confirm(args, {"metodo": "POST", "ruta": path, "valores": payload}, f"POST {path}", "¿Registrar la reimpresión?"):
        return 0
    _s, _h, body = api(args, "POST", path, body=payload)
    return emit(body, as_json=args.json, text=str((body or {}).get("message") or "Reimpresión registrada."))
