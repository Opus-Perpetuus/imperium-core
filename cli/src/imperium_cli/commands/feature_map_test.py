"""Datos de prueba de los feature maps (`feature_map_test`).

`imperium feature-map-test resumen` lista las filas marcadas por tabla y
`imperium feature-map-test purgar --si` las borra en masa (hijos antes que
padres; nunca filas reales). Solo el superadministrador semilla.
"""
from __future__ import annotations

from .common import api, confirm, emit

RUTA = "/api/feature-map-test"


def resumen(args) -> int:
    _s, _h, body = api(args, "GET", RUTA)
    tablas = (body or {}).get("tables") or []
    lineas = [f"{t.get('rows', 0):>6}  {t.get('table', '')}" for t in tablas]
    lineas.append(f"{(body or {}).get('total', 0)} filas de prueba en {len(tablas)} tablas.")
    return emit(body, as_json=args.json, text="\n".join(lineas))


def purgar(args) -> int:
    if getattr(args, "dry_run", False):
        return emit({"dry_run": True, "path": f"POST {RUTA}/purge"}, as_json=args.json, text=f"[dry-run] POST {RUTA}/purge")
    confirm(args, "¿Borrar todos los datos de prueba (feature_map_test = true)?")
    _s, _h, body = api(args, "POST", f"{RUTA}/purge", body={})
    body = body or {}
    lineas = [f"borrado {t.get('rows', 0):>6}  {t.get('table', '')}" for t in body.get("deleted") or []]
    lineas += [f"bloqueada {b.get('table', '')}: {b.get('error', '')}" for b in body.get("blocked") or []]
    lineas += [f"protegida {p.get('table', '')}: {p.get('rows', 0)} filas de estructura (no se purgan)" for p in body.get("protected") or []]
    lineas += [f"se quedan {k.get('table', '')}: {k.get('rows', 0)} cuentas semilla de bots (desmarcadas, no se borran)" for k in body.get("kept_accounts") or []]
    lineas.append(f"{body.get('total', 0)} filas de prueba borradas.")
    emit(body, as_json=args.json, text="\n".join(lineas))
    return 1 if body.get("blocked") else 0
