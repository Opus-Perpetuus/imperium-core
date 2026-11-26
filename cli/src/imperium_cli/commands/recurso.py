"""`imperium recurso <nombre> listar|ver|crear|editar|borrar`: CRUD genérico vía /api/meta."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from ..exits import CliError, NO_ENCONTRADO, PERMISO, VALIDACION
from .common import api, dry_or_confirm, emit, kv_pairs, query, rows_of, table_text


def load_meta(args) -> list[dict[str, Any]]:
    _s, _h, body = api(args, "GET", "/api/meta")
    resources: list[dict[str, Any]] = []
    for row in rows_of(body):
        if isinstance(row.get("resources"), list):
            resources.extend(r for r in row["resources"] if isinstance(r, dict))
        elif row.get("resource"):
            resources.append(row)
    return resources


def resolve(args, name: str, resources: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    wanted = name.strip().lower().strip("/")
    rows = resources if resources is not None else load_meta(args)
    for key in ("resource", "path", "table", "name"):
        for row in rows:
            if str(row.get(key) or "").lower().strip("/") == wanted:
                return row
    raise CliError(f"No hay un recurso «{name}» visible para tu usuario (revisa imperium recurso --listar).", NO_ENCONTRADO)


def base_path(meta: dict[str, Any]) -> str:
    path = str(meta.get("path") or f"/{meta['resource']}")
    return "/api/" + path.strip("/")


def require(meta: dict[str, Any], perm: str) -> None:
    if not (meta.get("permissions") or {}).get(perm):
        verbo = {"read": "leer", "create": "crear", "update": "editar", "delete": "borrar"}[perm]
        raise CliError(f"Tu usuario no puede {verbo} en «{meta.get('name') or meta['resource']}».", PERMISO)


def coerce(meta: dict[str, Any], values: dict[str, Any], *, creating: bool) -> dict[str, Any]:
    fields = {f["name"]: f for f in meta.get("fields") or [] if isinstance(f, dict) and f.get("name")}
    unknown = [k for k in values if fields and k not in fields and k not in ("_id",)]
    if unknown:
        raise CliError(f"Campos desconocidos para {meta['resource']}: {', '.join(unknown)}", VALIDACION)
    out: dict[str, Any] = {}
    for key, value in values.items():
        kind = str((fields.get(key) or {}).get("type") or "")
        out[key] = _coerce_one(value, kind)
        opts = (fields.get(key) or {}).get("options")
        if opts and out[key] not in ("", None) and str(out[key]) not in {str(o.get("value")) for o in opts}:
            raise CliError(f"Valor no válido para {key}: {value}", VALIDACION)
    if creating:
        missing = [n for n, f in fields.items() if f.get("required") and out.get(n) in (None, "")]
        if missing:
            raise CliError(f"Faltan campos obligatorios: {', '.join(missing)}", VALIDACION)
    return out


def _coerce_one(value: Any, kind: str) -> Any:
    if not isinstance(value, str):
        return value
    if kind in ("number", "integer", "numeric"):
        try:
            return int(value) if value.strip().lstrip("-").isdigit() else float(value)
        except ValueError as err:
            raise CliError(f"«{value}» no es un número.", VALIDACION) from err
    if kind == "boolean":
        return value.strip().lower() in ("1", "true", "si", "sí", "s", "yes")
    return value


def _values(args) -> dict[str, Any]:
    values: dict[str, Any] = dict(kv_pairs(getattr(args, "campo", None)))
    raw = getattr(args, "datos", None)
    if raw:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as err:
            raise CliError(f"--datos no es JSON válido: {err}", VALIDACION) from err
        if not isinstance(data, dict):
            raise CliError("--datos debe ser un objeto JSON.", VALIDACION)
        values = {**data, **values}
    return values


def recurso(args) -> int:
    resources = load_meta(args)
    if getattr(args, "nombre", None) in (None, "", "-"):
        rows = [{"recurso": r["resource"], "nombre": r.get("name"), "ruta": r.get("path")} for r in resources]
        return emit(rows, as_json=args.json, text=table_text(rows))
    meta = resolve(args, args.nombre, resources)
    verb = args.accion
    base = base_path(meta)
    if verb == "listar":
        require(meta, "read")
        limite = max(1, min(int(args.limite or 20), 200))
        params = {"termino": args.buscar, "desde": (max(1, int(args.pagina or 1)) - 1) * limite, "limite": limite}
        params.update(kv_pairs(args.filtro, "--filtro"))
        _s, _h, body = api(args, "GET", base + query(params))
        cols = [c["name"] for c in meta.get("list_columns") or [] if isinstance(c, dict)][:6] or None
        return emit(body, as_json=args.json, text=table_text(rows_of(body), cols))
    if verb == "ver":
        require(meta, "read")
        _id = _need_id(args)
        _s, _h, body = api(args, "GET", f"{base}/{quote(_id, safe='')}")
        rows = rows_of(body)
        text = "\n".join(f"{k}: {v}" for k, v in (rows[0] if rows else {}).items())
        return emit(body, as_json=args.json, text=text or "Sin datos.")
    if verb == "crear":
        require(meta, "create")
        payload = coerce(meta, _values(args), creating=True)
        if not dry_or_confirm(args, {"metodo": "POST", "ruta": base, "valores": payload}, f"POST {base}", f"¿Crear en {meta['resource']}?"):
            return 0
        _s, _h, body = api(args, "POST", base, body=payload)
        return emit(body, as_json=args.json, text=str((body or {}).get("message") or "Creado."))
    if verb == "editar":
        require(meta, "update")
        _id = _need_id(args)
        payload = coerce(meta, _values(args), creating=False)
        if not payload:
            raise CliError("Nada que editar: usa --campo clave=valor o --datos JSON.", VALIDACION)
        path = f"{base}/{quote(_id, safe='')}"
        if not dry_or_confirm(args, {"metodo": "PATCH", "ruta": path, "valores": payload}, f"PATCH {path}", f"¿Editar {_id}?"):
            return 0
        _s, _h, body = api(args, "PATCH", path, body=payload)
        return emit(body, as_json=args.json, text=str((body or {}).get("message") or "Editado."))
    if verb == "borrar":
        require(meta, "delete")
        _id = _need_id(args)
        path = f"{base}/id/{quote(_id, safe='')}"
        if not dry_or_confirm(args, {"metodo": "DELETE", "ruta": path}, f"DELETE {path}", f"¿Borrar {_id} de {meta['resource']}?"):
            return 0
        _s, _h, body = api(args, "DELETE", path)
        return emit(body, as_json=args.json, text=str((body or {}).get("message") or "Borrado."))
    raise CliError(f"Acción desconocida: {verb}", VALIDACION)


def _need_id(args) -> str:
    if not getattr(args, "id", None):
        raise CliError("Falta el id del registro.", VALIDACION)
    return str(args.id)
