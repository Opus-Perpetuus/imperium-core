"""`imperium pos caja`: venta de mostrador con lector de códigos (HID por stdin).

Producto: GET /api/products?codigo=… (y ?termino=… si no hay coincidencia).
Venta: POST /api/pos-tickets con ticket_type VENTA; reimpresión: POST /api/pos-tickets/reimpresion.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import Any

from ..exits import CliError, NO_ENCONTRADO, VALIDACION
from .common import api, dry_or_confirm, emit, query, rows_of

CODE_FIELDS = ("codigo_barras", "barcode", "codigo", "sku", "default_code", "code", "_id")
PRICE_FIELDS = ("precio_venta", "sale_price", "list_price", "precio", "price", "unit_price")
STOCK_FIELDS = ("existencia", "existencias", "stock", "qty_available", "cantidad")
PAGOS = {"efectivo": "cash_amount", "tarjeta": "card_amount", "transferencia": "transfer_amount"}


def _first(row: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if row.get(key) not in (None, ""):
            return row[key]
    return None


def _num(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def parse_item(spec: str) -> tuple[str, float]:
    """`750100`, `3*750100` o `750100x3` → (código, cantidad)."""
    text = spec.strip()
    qty = 1.0
    if "*" in text:
        left, _, text = text.partition("*")
        qty = _num(left)
    elif "x" in text.lower() and text.lower().rsplit("x", 1)[1].replace(".", "", 1).isdigit():
        text, _, right = text.lower().rpartition("x")
        qty = _num(right)
    text = text.strip()
    if not text or qty <= 0:
        raise CliError(f"Artículo no válido: «{spec}».", VALIDACION)
    return text, qty


@dataclass
class Linea:
    producto: dict[str, Any]
    codigo: str
    cantidad: float

    @property
    def precio(self) -> float:
        return _num(_first(self.producto, PRICE_FIELDS))

    @property
    def total(self) -> float:
        return round(self.precio * self.cantidad, 2)


@dataclass
class Carrito:
    lineas: list[Linea] = field(default_factory=list)

    def agregar(self, producto: dict[str, Any], codigo: str, cantidad: float) -> Linea:
        for linea in self.lineas:
            if linea.producto.get("_id") == producto.get("_id"):
                linea.cantidad += cantidad
                return linea
        linea = Linea(producto, codigo, cantidad)
        self.lineas.append(linea)
        return linea

    def quitar_ultima(self) -> Linea | None:
        return self.lineas.pop() if self.lineas else None

    @property
    def subtotal(self) -> float:
        return round(sum(l.total for l in self.lineas), 2)


def buscar_producto(args, codigo: str) -> dict[str, Any]:
    wanted = codigo.strip().lower()
    for param in ("codigo", "termino"):
        _s, _h, body = api(args, "GET", "/api/products" + query({param: codigo, "limite": 10}))
        rows = rows_of(body)
        exact = [r for r in rows if any(str(r.get(k) or "").lower() == wanted for k in CODE_FIELDS)]
        if len(exact) == 1 or (len(exact) > 1 and len({str(r.get("_id")) for r in exact}) == 1):
            return exact[0]
        if len(rows) == 1 and param == "codigo":
            return rows[0]
    raise CliError(f"No encontré un producto con código «{codigo}».", NO_ENCONTRADO)


def cambio(total: float, efectivo: float | None) -> float:
    if efectivo is None:
        return 0.0
    if efectivo + 1e-9 < total:
        raise CliError(f"Efectivo insuficiente: total {total:.2f}, recibido {efectivo:.2f}.", VALIDACION)
    return round(efectivo - total, 2)


def ticket_payload(carrito: Carrito, *, sesion: str | None, pago: str, efectivo: float | None) -> dict[str, Any]:
    if not carrito.lineas:
        raise CliError("El carrito está vacío.", VALIDACION)
    if pago not in PAGOS:
        raise CliError(f"Forma de pago no válida: {pago}.", VALIDACION)
    total = carrito.subtotal
    recibido = efectivo if pago == "efectivo" and efectivo is not None else total
    change = cambio(total, recibido) if pago == "efectivo" else 0.0
    return {
        "ticket_type": "VENTA",
        "pos_session": sesion,
        "items": [{"item_id": str(l.producto.get("_id")), "quantity": l.cantidad, "unit_price": l.precio, "total": l.total} for l in carrito.lineas],
        "subtotal": total,
        "total_paid": recibido,
        "change": change,
        "payment_method": pago,
        "payments": [{"method": pago, "amount": total}],
        PAGOS[pago]: total,
    }


def _sesion_abierta(args) -> str | None:
    _s, _h, body = api(args, "GET", "/api/pos-session" + query({"status": "abierta", "limite": 1}))
    rows = rows_of(body)
    return str(rows[0].get("_id")) if rows else None


def _linea_text(linea: Linea) -> str:
    stock = _first(linea.producto, STOCK_FIELDS)
    nombre = linea.producto.get("name") or linea.producto.get("nombre") or linea.codigo
    extra = f"  existencia {stock}" if stock is not None else ""
    return f"{linea.cantidad:g} × {nombre}  {linea.precio:.2f} = {linea.total:.2f}{extra}"


def _escanear(args, carrito: Carrito, stream) -> None:
    out = sys.stderr
    out.write("Escanea o escribe código (3*código para cantidad, - quita el último, vacío o «cobrar» termina, «cancelar» sale).\n")
    for raw in stream:
        line = raw.strip()
        if line.lower() in ("", "cobrar", "fin"):
            return
        if line.lower() == "cancelar":
            raise CliError("Venta cancelada.", VALIDACION)
        if line == "-":
            quitada = carrito.quitar_ultima()
            out.write(f"Quitado: {_linea_text(quitada)}\n" if quitada else "Carrito vacío.\n")
            continue
        try:
            codigo, qty = parse_item(line)
            linea = carrito.agregar(buscar_producto(args, codigo), codigo, qty)
            out.write(f"{_linea_text(linea)}   subtotal {carrito.subtotal:.2f}\n")
        except CliError as err:
            out.write(err.message + "\n")


def caja(args, stream=None) -> int:
    carrito = Carrito()
    specs = list(args.codigo or []) + list(args.item or [])
    for spec in specs:
        codigo, qty = parse_item(spec)
        carrito.agregar(buscar_producto(args, codigo), codigo, qty)
    if not specs:
        _escanear(args, carrito, stream or sys.stdin)
    efectivo = args.efectivo
    if args.pago == "efectivo" and efectivo is None and not specs and not args.dry_run and not args.yes:
        try:
            raw = input(f"Total {carrito.subtotal:.2f}. Efectivo recibido: ").strip()
            efectivo = _num(raw) if raw else None
        except EOFError:
            efectivo = None
    sesion = args.sesion or (None if args.dry_run else _sesion_abierta(args))
    if not sesion and not args.dry_run:
        raise CliError("No hay sesión POS abierta; indica --sesion.", VALIDACION)
    payload = ticket_payload(carrito, sesion=sesion, pago=args.pago, efectivo=efectivo)
    resumen = "\n".join(_linea_text(l) for l in carrito.lineas) + f"\nTotal {payload['subtotal']:.2f}  pago {args.pago}  cambio {payload['change']:.2f}"
    if not dry_or_confirm(args, {"metodo": "POST", "ruta": "/api/pos-tickets", "valores": payload}, resumen, f"{resumen}\n¿Registrar la venta?"):
        return 0
    _s, _h, body = api(args, "POST", "/api/pos-tickets", body=payload)
    ticket = rows_of(body)[0] if rows_of(body) else {}
    result: dict[str, Any] = {"ok": True, "ticket": ticket, "total": payload["subtotal"], "cambio": payload["change"]}
    if args.reimprimir and ticket.get("_id"):
        _s, _h, rb = api(args, "POST", "/api/pos-tickets/reimpresion", body={"tipo": "ticket", "id": ticket["_id"]})
        result["reimpresion"] = rb
    folio = ticket.get("ticket_sequence") or ticket.get("_id") or ""
    return emit(result, as_json=args.json, text=f"{resumen}\nVenta registrada {folio}.")
