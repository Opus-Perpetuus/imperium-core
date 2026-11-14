"""Registro de entradas: cada tipo de campo de Imperium → un input de flexablelib.

Dos fuentes hablan de campos:

* `/api/meta` (CRUD del núcleo): `component` (`input-text`, `input-number`,
  `input-checkbox`, `input-json`, `input-menu`, `input-date`, `input-money`,
  `input-textarea`, `input-icon`), `type` (`string`/`number`/`boolean`/`json`),
  `options` y `ref`.
* Los descriptores `nox.*` de las apps: `nox.input-<tipo>` con sus props.

Las dos pasan por `input_for(kind, props)`, así un mismo tipo se ve igual en
la lista del núcleo y en las pantallas de las apps. `KINDS` es la tabla
completa; `tests/test_tui_completa.py` comprueba que cada clase de entrada de
flexablelib sale de al menos un tipo.
"""

from __future__ import annotations

import datetime as _dt
import json
import re
from typing import Any, Callable

from flexablelib_components import (
    IMAGE_EXTENSIONS,
    MASKS,
    Autocomplete,
    Checkbox,
    CheckboxGroup,
    ColorInput,
    CoordinatesInput,
    DateInput,
    DateRangeInput,
    DateTimeInput,
    ExpressionInput,
    FileInput,
    IconPicker,
    JsonInput,
    MaskedInput,
    MoneyInput,
    MonthInput,
    NumberInput,
    PasswordInput,
    RadioGroup,
    ScanInput,
    Select,
    SignatureInput,
    Stopwatch,
    Switch,
    TextArea,
    TextInput,
    TimeInput,
    WeekdayInput,
    WeekInput,
    YearInput,
)
from flexablelib_components.base import Input


class ImageFileInput(FileInput):
    """Imagen a subir (ruta local) con la URL guardada a la vista: `current`
    es lo que ya tiene el registro (URL o data URL) y se pinta con `Image`."""

    def __init__(self, label=None, value=None, current: str = "", **kwargs):
        self.current = current
        super().__init__(label=label, value=value, extensions=IMAGE_EXTENSIONS, **kwargs)


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _number(value: Any) -> float | int | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    try:
        text = str(value).replace(",", "").strip()
        return int(text) if re.fullmatch(r"-?\d+", text) else float(text)
    except ValueError:
        return None


def _date(value: Any) -> _dt.date | None:
    if isinstance(value, _dt.datetime):
        return value.date()
    if isinstance(value, _dt.date):
        return value
    text = _text(value).strip()
    if not text:
        return None
    try:
        return _dt.date.fromisoformat(text[:10])
    except ValueError:
        return None


def _datetime(value: Any) -> _dt.datetime | None:
    if isinstance(value, _dt.datetime):
        return value
    text = _text(value).strip().replace("Z", "+00:00")
    if not text:
        return None
    try:
        parsed = _dt.datetime.fromisoformat(text)
    except ValueError:
        day = _date(text)
        return _dt.datetime.combine(day, _dt.time()) if day else None
    return parsed.replace(tzinfo=None)


def _time(value: Any) -> _dt.time | None:
    if isinstance(value, _dt.time):
        return value
    text = _text(value).strip()
    if not text:
        return None
    try:
        return _dt.time.fromisoformat(text[:8])
    except ValueError:
        stamp = _datetime(text)
        return stamp.time() if stamp else None


def _json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value) if value.strip() else None
        except json.JSONDecodeError:
            return value
    return value


def _options(props: dict[str, Any]) -> list[Any]:
    raw = props.get("options") or props.get("items") or props.get("choices") or []
    if isinstance(raw, dict):
        return [{"value": k, "label": v} for k, v in raw.items()]
    out: list[Any] = []
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, dict):
            value = item.get("value", item.get("id", item.get("_id", item.get("label"))))
            out.append({"value": value, "label": str(item.get("label") or item.get("name") or item.get("text") or value)})
        else:
            out.append(item)
    return out


def _many(value: Any) -> list[Any]:
    if value in (None, ""):
        return []
    if isinstance(value, (list, tuple, set)):
        return list(value)
    parsed = _json(value)
    if isinstance(parsed, list):
        return parsed
    return [v.strip() for v in str(value).split(",") if v.strip()]


def _mask(props: dict[str, Any]) -> str:
    mask = str(props.get("mask") or props.get("pattern") or props.get("format") or "phone")
    return mask if mask in MASKS or any(c in mask for c in "#AX*") else "phone"


def _range(value: Any) -> tuple[_dt.date, _dt.date] | None:
    if isinstance(value, dict):
        start, end = _date(value.get("start") or value.get("desde")), _date(value.get("end") or value.get("hasta"))
    elif isinstance(value, (list, tuple)) and len(value) == 2:
        start, end = _date(value[0]), _date(value[1])
    else:
        parts = re.split(r"\s*(?:/|\.\.|,| a )\s*", _text(value)) if value else []
        start, end = (_date(parts[0]), _date(parts[1])) if len(parts) == 2 else (None, None)
    return (start, end) if start and end else None


def _coords(value: Any) -> dict[str, float] | None:
    value = _json(value)
    if isinstance(value, dict):
        lat = _number(value.get("latitude", value.get("lat")))
        lng = _number(value.get("longitude", value.get("lng", value.get("lon"))))
    elif isinstance(value, (list, tuple)) and len(value) == 2:
        lat, lng = _number(value[0]), _number(value[1])
    elif isinstance(value, str) and "," in value:
        a, b = value.split(",", 1)
        lat, lng = _number(a), _number(b)
    else:
        return None
    return {"latitude": float(lat), "longitude": float(lng)} if lat is not None and lng is not None else None


def _weekday(value: Any) -> int | None:
    if value in (None, ""):
        return None
    number = _number(value)
    if number is not None:
        return int(number) % 7
    names = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]
    text = _text(value).strip().lower()[:3].replace("mie", "mié").replace("sab", "sáb")
    return names.index(text) if text in names else None


def _icon(value: Any) -> str | None:
    text = _text(value).strip()
    return text or None


Builder = Callable[[dict[str, Any], dict[str, Any]], Input]


def _b(cls, coerce=None, **fixed) -> Builder:
    def build(common: dict[str, Any], props: dict[str, Any]) -> Input:
        value = props.get("value", props.get("default"))
        kwargs = dict(common, **fixed)
        kwargs["value"] = coerce(value) if coerce else value
        return cls(**kwargs)

    return build


def _text_b(cls=TextInput, **fixed) -> Builder:
    def build(common: dict[str, Any], props: dict[str, Any]) -> Input:
        kwargs = dict(common, **fixed)
        kwargs["value"] = _text(props.get("value", props.get("default")))
        if props.get("placeholder"):
            kwargs["placeholder"] = str(props["placeholder"])
        if props.get("max_length") or props.get("maxlength"):
            kwargs.setdefault("max_length", int(props.get("max_length") or props.get("maxlength")))
        return cls(**kwargs)

    return build


def _number_b(cls=NumberInput) -> Builder:
    def build(common: dict[str, Any], props: dict[str, Any]) -> Input:
        kwargs = dict(common)
        for key, name in (("min", "minimum"), ("minimum", "minimum"), ("max", "maximum"), ("maximum", "maximum")):
            if _number(props.get(key)) is not None:
                kwargs[name] = _number(props[key])
        kwargs["value"] = _number(props.get("value", props.get("default")))
        return cls(**kwargs)

    return build


def _choice_b(cls, **fixed) -> Builder:
    def build(common: dict[str, Any], props: dict[str, Any]) -> Input:
        kwargs = dict(common, **fixed)
        kwargs["options"] = _options(props)
        value = props.get("value", props.get("default"))
        kwargs["value"] = _many(value) if cls is CheckboxGroup else value
        return cls(**kwargs)

    return build


def _image_b(common: dict[str, Any], props: dict[str, Any]) -> Input:
    value = props.get("value")
    current = value[0] if isinstance(value, list) and value else value
    return ImageFileInput(current=_text(current), multiple=bool(props.get("multiple")), **common)


def _mask_b(common: dict[str, Any], props: dict[str, Any]) -> Input:
    return MaskedInput(mask=_mask(props), value=_text(props.get("value")), **common)


def _scan_b(common: dict[str, Any], props: dict[str, Any]) -> Input:
    # `keep_value=True` (default de flexablelib 3.7): el valor es el último código leído.
    return ScanInput(value=_text(props.get("value")), pattern=props.get("pattern") or None, **common)


def _signature_b(common: dict[str, Any], props: dict[str, Any]) -> Input:
    """Firma a mano (flechas mueven la pluma, Espacio la baja). La firma que ya
    tenía el registro (URL o data URL) se enseña como imagen (`current`)."""
    value = props.get("value")
    widget = SignatureInput(columns=int(props.get("columns") or 40), rows=int(props.get("rows") or 8), **common)
    if isinstance(value, list) and all(isinstance(s, (list, tuple)) for s in value):
        widget.value = value
    widget.current = _text(value) if isinstance(value, str) else ""  # type: ignore[attr-defined]
    return widget


def _duration(value: Any) -> _dt.timedelta | None:
    if isinstance(value, _dt.timedelta):
        return value
    number = _number(value)
    if number is not None:
        return _dt.timedelta(seconds=float(number))
    moment = _time(value)
    return _dt.timedelta(hours=moment.hour, minutes=moment.minute, seconds=moment.second) if moment else None


def signature_png(widget: Any) -> str | None:
    """La firma dibujada como data URL PNG (lo que guarda el web); None si está vacía."""
    if not isinstance(widget, SignatureInput) or widget.is_empty():
        return None
    import base64

    return "data:image/png;base64," + base64.b64encode(widget.to_png()).decode("ascii")


def form_payload(form: Any, values: dict[str, Any]) -> dict[str, Any]:
    """`values()` del formulario listo para el núcleo: firmas como PNG (una
    firma sin trazos no pisa la guardada) y cronómetros en segundos."""
    out = dict(values)
    for field in getattr(form, "fields", lambda: [])():
        name = getattr(field, "name", None)
        if not name or name not in out:
            continue
        if isinstance(field, SignatureInput):
            png = signature_png(field)
            if png:
                out[name] = png
            else:
                out.pop(name)
        elif isinstance(field, Stopwatch):
            out[name] = round(field.value.total_seconds(), 3) if field.value is not None else None
    return out


def _code_b(common: dict[str, Any], props: dict[str, Any]) -> Input:
    language = str(props.get("language") or props.get("lang") or "").lower()
    if language == "json":
        return JsonInput(value=_json(props.get("value")), **common)
    return TextArea(value=_text(props.get("value")), rows=int(props.get("rows") or 8), **common)


# Tipo (sin el prefijo `nox.`) → constructor. Todas las entradas `nox.input-*`
# del catálogo de componentes del kit y los `component` de `/api/meta`.
KINDS: dict[str, Builder] = {
    "input-text": _text_b(),
    "input-email": _text_b(),
    "input-url": _text_b(),
    "input-password": _text_b(PasswordInput),
    "input-number": _number_b(),
    "input-money": _number_b(MoneyInput),
    "input-operacion": _b(ExpressionInput, _number),
    "input-textarea": _b(TextArea, _text),
    "input-markdown": _b(TextArea, _text, help="Markdown"),
    "input-editor-html-pdf": _b(TextArea, _text, help="HTML (se imprime como PDF en la GUI)"),
    "input-code-editor": _code_b,
    "input-json": _b(JsonInput, _json),
    "input-object": _b(JsonInput, _json),
    "input-checkbox": _b(Checkbox, lambda v: str(v).lower() in ("1", "true", "sí", "si", "on") if isinstance(v, str) else bool(v)),
    "input-switch": _b(Switch, lambda v: str(v).lower() in ("1", "true", "sí", "si", "on") if isinstance(v, str) else bool(v)),
    "input-radio-group": _choice_b(RadioGroup),
    "input-radio-buttons": _choice_b(RadioGroup, layout="buttons"),
    "input-choice": _choice_b(RadioGroup, layout="buttons"),
    "input-checkbox-group": _choice_b(CheckboxGroup),
    "input-menu": _choice_b(Select),
    "input-status": _choice_b(Select),
    "input-select": _choice_b(Select),
    "input-datalist": _choice_b(Autocomplete),
    "input-date": _b(DateInput, _date),
    "input-datetime": _b(DateTimeInput, _datetime),
    "input-time": _b(TimeInput, _time),
    "input-timer": _b(TimeInput, _time, seconds=True),
    "input-stopwatch": _b(Stopwatch, _duration),
    "input-cronometro": _b(Stopwatch, _duration),
    "input-date-range": _b(DateRangeInput, _range),
    "input-week": _b(WeekInput, _date),
    "input-month": _b(MonthInput, _date),
    "input-year": _b(YearInput, lambda v: int(_number(v)) if _number(v) is not None else None, as_int=True),
    "input-weekday": _b(WeekdayInput, _weekday),
    "input-color": _text_b(ColorInput),
    "input-icon": _b(IconPicker, _icon),
    "input-coordinates": _b(CoordinatesInput, _coords),
    "input-mask": _mask_b,
    "input-scanner": _scan_b,
    "input-file": _b(FileInput, lambda v: _text(v) or None),
    "input-image": _image_b,
    "input-signature": _signature_b,
}

# Tipos de `nox.*` que no son campos de captura (no se cuentan en el formulario).
NON_FIELDS = {"input-hidden", "input-subtable"}

# `type` de `/api/meta` cuando `component` viene vacío.
TYPE_DEFAULTS = {
    "number": "input-number",
    "integer": "input-number",
    "numeric": "input-number",
    "boolean": "input-checkbox",
    "json": "input-json",
    "date": "input-date",
    "datetime": "input-datetime",
    "string": "input-text",
}

# Por nombre de columna: lo que el catálogo guarda como `input-text` pero es
# otra cosa (imágenes, contraseñas, teléfonos, RFC/CURP, coordenadas, colores).
NAME_HINTS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(^|_)(image|imagen|imagenes|img|foto|fotos|fotografia|logo|avatar|picture|photo)s?($|_)", re.I), "input-image"),
    (re.compile(r"(^|_)(firma|signature)($|_)", re.I), "input-signature"),
    (re.compile(r"(^|_)(password|contrasena|contraseña|pin)($|_)", re.I), "input-password"),
    (re.compile(r"(^|_)(telefono|teléfono|phone|celular|movil|whatsapp)($|_)", re.I), "input-mask:phone"),
    (re.compile(r"(^|_)rfc($|_)", re.I), "input-mask:rfc"),
    (re.compile(r"(^|_)curp($|_)", re.I), "input-mask:curp"),
    (re.compile(r"(^|_)(cp|codigo_postal|postal_code|zip)($|_)", re.I), "input-mask:postal_code"),
    (re.compile(r"(^|_)(coordenadas|coordinates|ubicacion_gps|geo)($|_)", re.I), "input-coordinates"),
    (re.compile(r"(^|_)(color|colour)($|_)", re.I), "input-color"),
    (re.compile(r"(^|_)(codigo_barras|barcode|qr)($|_)", re.I), "input-scanner"),
    (re.compile(r"(^|_)(fecha_hora|datetime|timestamp)($|_)|_at$", re.I), "input-datetime"),
    (re.compile(r"(^|_)(fecha|date|dia)($|_)", re.I), "input-date"),
    (re.compile(r"(^|_)(hora|time)($|_)", re.I), "input-time"),
    (re.compile(r"(^|_)(precio|costo|importe|total|monto|price|cost|amount)($|_)", re.I), "input-money"),
    (re.compile(r"(^|_)(descripcion|description|notas|notes|comentarios|observaciones)($|_)", re.I), "input-textarea"),
]


MONEY_NAMES = re.compile(r"(^|_)(precio|costo|importe|total|monto|price|cost|amount)($|_)", re.I)


def meta_kind(field: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Tipo nox para un campo de `/api/meta` y props extra (máscara, opciones)."""
    component = str(field.get("component") or "").strip()
    crud = str(field.get("type") or "").strip()
    name = str(field.get("name") or "")
    extra: dict[str, Any] = {}
    if field.get("options"):
        return ("input-menu" if len(field["options"]) > 3 else "input-radio-buttons"), extra
    if field.get("ref"):
        return "input-datalist", extra
    kind = component if component in KINDS and component not in ("input-text", "") else ""
    if not kind and crud in ("", "string"):
        for pattern, hinted in NAME_HINTS:
            if pattern.search(name):
                kind, _, mask = hinted.partition(":")
                if mask:
                    extra["mask"] = mask
                break
    if not kind and crud in ("number", "integer", "numeric"):
        kind = "input-money" if MONEY_NAMES.search(name) else "input-number"
    return kind or component or TYPE_DEFAULTS.get(crud, "input-text"), extra


def input_for(kind: str, props: dict[str, Any], *, options_loader: Callable[[str], list[Any]] | None = None) -> Input | None:
    """Construye el input de flexablelib para `kind` (`input-*` o `nox.input-*`).

    `props`: `name`, `label`, `value`, `required`, `help`, `options`, `ref`…
    Devuelve None para `input-hidden` / `input-subtable` (los maneja quien arma
    el formulario) y TextInput para un tipo desconocido.
    """
    kind = kind.removeprefix("nox.")
    if kind in NON_FIELDS:
        return None
    name = str(props.get("name") or props.get("key") or "").strip() or None
    label = str(props.get("label") or props.get("title") or name or "Campo")
    if props.get("ref") and not props.get("options") and options_loader is not None:
        props = dict(props, options=options_loader(str(props["ref"])))
    common: dict[str, Any] = {
        "label": label,
        "name": name,
        "required": bool(props.get("required")),
        "a11y_label": label,
    }
    if props.get("help") or props.get("hint"):
        common["help"] = str(props.get("help") or props.get("hint"))
    builder = KINDS.get(kind) or KINDS["input-text"]
    try:
        widget = builder(common, props)
    except (TypeError, ValueError):
        widget = TextInput(value=_text(props.get("value")), **common)
    widget.imperium_kind = kind  # type: ignore[attr-defined]
    # Ancho en la rejilla del formulario, tal como lo declara el núcleo/la app.
    span = props.get("column_span", props.get("columnSpan", props.get("span")))
    widget.column_span = span  # type: ignore[attr-defined]
    widget.min_width = props.get("min_width", props.get("minWidth"))  # type: ignore[attr-defined]
    return widget


def meta_input(field: dict[str, Any], *, value: Any = None, options_loader=None) -> Input | None:
    kind, extra = meta_kind(field)
    props = dict(field, **extra)
    if value is not None:
        props["value"] = value
    return input_for(kind, props, options_loader=options_loader)


def flexablelib_input_classes() -> set[type]:
    """Todas las clases de entrada públicas de flexablelib (para la prueba de cobertura)."""
    import flexablelib_components as fc

    out: set[type] = set()
    for name in getattr(fc, "__all__", dir(fc)):
        obj = getattr(fc, name, None)
        if isinstance(obj, type) and issubclass(obj, Input) and obj is not Input:
            out.add(obj)
    return out
