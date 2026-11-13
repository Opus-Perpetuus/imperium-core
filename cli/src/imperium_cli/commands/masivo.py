"""`imperium masivo importar|editar|borrar <recurso> --desde archivo.csv|xlsx`.

Sin `--yes` solo muestra el plan (dry-run). Ejecuta por lotes y guarda el
avance en `$XDG_STATE_HOME/imperium/masivo/<id>.json` para `--continuar <id>`.
`borrar` exige un respaldo del núcleo terminado antes de tocar un registro.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote

from ..exits import CliError, ERROR, NO_ENCONTRADO, USO, VALIDACION
from .common import api, emit, kv_pairs, query, rows_of
from .recurso import base_path, coerce, require, resolve

_sleep = time.sleep
BACKUP_TIMEOUT_S = 1800
PERM = {"importar": "create", "editar": "update", "borrar": "delete"}


def state_dir() -> Path:
    xdg = os.environ.get("XDG_STATE_HOME", "").strip()
    base = Path(xdg).expanduser() if xdg else Path.home() / ".local" / "state"
    return base / "imperium" / "masivo"


def read_rows(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise CliError(f"No existe el archivo {path}.", NO_ENCONTRADO)
    suffix = path.suffix.lower()
    if suffix == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as fh:
            return [{k.strip(): (v or "").strip() for k, v in row.items() if k} for row in csv.DictReader(fh)]
    if suffix in (".xlsx", ".xlsm"):
        from openpyxl import load_workbook

        sheet = load_workbook(path, read_only=True, data_only=True).active
        it = sheet.iter_rows(values_only=True)
        header = [str(h).strip() if h is not None else "" for h in next(it, [])]
        out = []
        for values in it:
            if values is None or all(v in (None, "") for v in values):
                continue
            out.append({h: ("" if v is None else v if not isinstance(v, str) else v.strip()) for h, v in zip(header, values) if h})
        return out
    raise CliError("Formato no soportado: usa .csv o .xlsx.", VALIDACION)


def build_plan(meta: dict[str, Any], rows: list[dict[str, Any]], op: str, mapping: dict[str, str], match: str | None) -> dict[str, Any]:
    ok_rows: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for index, raw in enumerate(rows, start=1):
        mapped = {mapping.get(k, k): v for k, v in raw.items() if mapping.get(k, k) and v not in (None, "")}
        try:
            if op == "borrar":
                if not mapped.get("_id"):
                    raise CliError("falta _id", VALIDACION)
                values: dict[str, Any] = {"_id": str(mapped["_id"])}
            else:
                values = coerce(meta, mapped, creating=op == "importar")
                if op == "editar" and not values.get(match or "_id"):
                    raise CliError(f"falta {match or '_id'} para encontrar el registro", VALIDACION)
            ok_rows.append({"fila": index, "valores": values})
        except CliError as err:
            errors.append({"fila": index, "error": err.message})
    return {"total": len(rows), "validas": len(ok_rows), "con_errores": len(errors), "errores": errors, "filas": ok_rows}


def _save(state: dict[str, Any]) -> Path:
    target = state_dir() / f"{state['id']}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(target)
    return target


def _load(job_id: str) -> dict[str, Any]:
    target = state_dir() / f"{Path(job_id).name}.json"
    if not target.is_file():
        raise CliError(f"No hay un trabajo masivo «{job_id}» que continuar.", NO_ENCONTRADO)
    return json.loads(target.read_text(encoding="utf-8"))


def _progress(state: dict[str, Any]) -> None:
    done = len(state["resultados"])
    sys.stderr.write(f"\r[{state['id']}] {done}/{state['validas']} filas procesadas")
    sys.stderr.flush()


def backup_before_delete(args, state: dict[str, Any]) -> str:
    label = f"masivo-borrar {state['recurso']} {state['id']}"
    _s, _h, body = api(args, "POST", "/api/db-admin/backups", body={"label": label})
    task = (rows_of(body) or [{}])[0]
    task_id = task.get("id")
    if not task_id:
        raise CliError("El núcleo no devolvió el trabajo del respaldo; no borro nada.", ERROR)
    sys.stderr.write(f"Respaldo previo en curso ({task_id})…\n")
    waited = 0.0
    while True:
        _s, _h, body = api(args, "GET", f"/api/db-admin/tasks/{quote(str(task_id), safe='')}")
        task = (rows_of(body) or [{}])[0]
        status = task.get("status")
        if status == "success":
            result = task.get("result") if isinstance(task.get("result"), dict) else {}
            return str(result.get("id") or task_id)
        if status == "error":
            raise CliError(f"El respaldo previo falló ({task.get('error') or 'sin detalle'}); no borro nada.", ERROR)
        if waited >= BACKUP_TIMEOUT_S:
            raise CliError("El respaldo previo no terminó a tiempo; no borro nada.", ERROR)
        _sleep(2)
        waited += 2


def _run_batch(args, state: dict[str, Any], batch: list[dict[str, Any]]) -> list[dict[str, Any]]:
    base = state["ruta"]
    if state["operacion"] == "borrar":
        out = []
        for item in batch:
            _id = item["valores"]["_id"]
            try:
                api(args, "DELETE", f"{base}/id/{quote(_id, safe='')}")
                out.append({"fila": item["fila"], "estado": "borrado", "id": _id, "mensaje": ""})
            except CliError as err:
                if err.code in (4, 5, 8, 9):
                    raise
                out.append({"fila": item["fila"], "estado": "error", "id": _id, "mensaje": err.message})
        return out
    match = state.get("coincidir") or ("_id" if state["operacion"] == "editar" else None)
    path = f"{base}/batch" + query({"batch_match_field": match})
    _s, _h, body = api(args, "PUT", path, body=[i["valores"] for i in batch])
    body = body if isinstance(body, dict) else {}
    out = []
    by_row = {int(r.get("row", 0)): r for r in body.get("success") or [] if isinstance(r, dict)}
    errs = {int(r.get("row", 0)): r for r in body.get("errors") or [] if isinstance(r, dict)}
    for pos, item in enumerate(batch, start=1):
        if pos in by_row:
            hit = by_row[pos]
            estado = "actualizado" if hit.get("operation") == "update" else "creado"
            out.append({"fila": item["fila"], "estado": estado, "id": hit.get("_id"), "mensaje": "; ".join(hit.get("warnings") or [])})
        else:
            msg = "; ".join(errs.get(pos, {}).get("errors") or ["sin respuesta del núcleo"])
            out.append({"fila": item["fila"], "estado": "error", "id": item["valores"].get("_id"), "mensaje": msg})
    return out


def _write_report(state: dict[str, Any]) -> Path:
    target = Path(state["reporte"]).expanduser()
    with target.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=["fila", "estado", "id", "mensaje"])
        writer.writeheader()
        for err in state["errores_plan"]:
            writer.writerow({"fila": err["fila"], "estado": "rechazada", "id": "", "mensaje": err["error"]})
        for row in state["resultados"]:
            writer.writerow(row)
    return target


def _confirm_count(args, plan: dict[str, Any], op: str) -> bool:
    if getattr(args, "yes", False):
        return True
    if getattr(args, "dry_run", False) or not sys.stdin.isatty():
        return False
    try:
        answer = input(f"Escribe {plan['validas']} para {op} {plan['validas']} fila(s): ").strip()
    except EOFError as err:
        raise CliError("Se necesita confirmación.", USO) from err
    if answer != str(plan["validas"]):
        raise CliError("Operación cancelada.", USO)
    return True


def masivo(args) -> int:
    if getattr(args, "continuar", None):
        state = _load(args.continuar)
        current = hashlib.sha256(Path(state["archivo"]).read_bytes()).hexdigest() if Path(state["archivo"]).is_file() else ""
        if current != state["sha256"]:
            raise CliError("El archivo cambió desde que empezó el trabajo; no lo continúo.", VALIDACION)
        return _execute(args, state)
    op = args.operacion
    if not args.recurso or not args.desde:
        raise CliError("Uso: imperium masivo <importar|editar|borrar> <recurso> --desde archivo.csv|xlsx", VALIDACION)
    meta = resolve(args, args.recurso)
    require(meta, PERM[op])
    path = Path(args.desde).expanduser().resolve()
    rows = read_rows(path)
    plan = build_plan(meta, rows, op, kv_pairs(args.mapeo, "--mapeo"), args.coincidir)
    summary = {k: plan[k] for k in ("total", "validas", "con_errores", "errores")}
    summary.update(operacion=op, recurso=meta["resource"], respaldo_previo=op == "borrar")
    if not _confirm_count(args, plan, op):
        lines = [f"[dry-run] {op} {meta['resource']}: {plan['total']} filas, {plan['validas']} válidas, {plan['con_errores']} con errores."]
        lines += [f"  fila {e['fila']}: {e['error']}" for e in plan["errores"][:20]]
        if op == "borrar":
            lines.append("  Antes de borrar se hará un respaldo automático de la base.")
        lines.append("  Agrega --yes para ejecutar.")
        return emit({"dry_run": True, **summary}, as_json=args.json, text="\n".join(lines))
    if not plan["validas"]:
        raise CliError("No hay filas válidas que procesar.", VALIDACION)
    job_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    state = {
        "id": job_id,
        "operacion": op,
        "recurso": meta["resource"],
        "ruta": base_path(meta),
        "archivo": str(path),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "coincidir": args.coincidir,
        "lote": max(1, min(int(args.lote or 100), 500)),
        "validas": plan["validas"],
        "filas": plan["filas"],
        "errores_plan": plan["errores"],
        "siguiente": 0,
        "respaldo": None,
        "resultados": [],
        "reporte": str(Path(args.reporte or f"masivo-{job_id}-reporte.csv").expanduser().resolve()),
    }
    _save(state)
    sys.stderr.write(f"Trabajo {job_id} (si se corta: imperium masivo --continuar {job_id})\n")
    return _execute(args, state)


def _execute(args, state: dict[str, Any]) -> int:
    if state["operacion"] == "borrar" and not state.get("respaldo"):
        state["respaldo"] = backup_before_delete(args, state)
        _save(state)
    filas = state["filas"]
    while state["siguiente"] < len(filas):
        batch = filas[state["siguiente"] : state["siguiente"] + state["lote"]]
        state["resultados"].extend(_run_batch(args, state, batch))
        state["siguiente"] += len(batch)
        _save(state)
        _progress(state)
    sys.stderr.write("\n")
    report = _write_report(state)
    fallidas = sum(1 for r in state["resultados"] if r["estado"] == "error")
    result = {
        "ok": fallidas == 0,
        "id": state["id"],
        "operacion": state["operacion"],
        "recurso": state["recurso"],
        "procesadas": len(state["resultados"]),
        "con_error": fallidas,
        "rechazadas_en_plan": len(state["errores_plan"]),
        "respaldo": state.get("respaldo"),
        "reporte": str(report),
    }
    text = f"{state['operacion']} {state['recurso']}: {result['procesadas']} procesadas, {fallidas} con error. Reporte: {report}"
    emit(result, as_json=args.json, text=text)
    return 0 if fallidas == 0 else VALIDACION
