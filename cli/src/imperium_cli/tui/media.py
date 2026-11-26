"""Imágenes en la terminal (productos, herramientas, evidencias, firmas…).

`flexablelib_components.Image` ya elige el mejor método que tenga la terminal
(kitty, iTerm2, sixel; si no, bloques Unicode medios/cuartos/sextantes,
braille o ASCII), cae a un enlace y marca el foco también en texto
alternativo. Aquí solo se decide QUÉ es una imagen y se baja con el token del
perfil (`Backend.fetch_bytes`, que usa `read_source(headers=)` de flexablelib:
`Authorization` solo va al núcleo y nunca sigue a una redirección).

`IMPERIUM_IMAGEN=half|sixel|kitty|iterm|ascii|link|none` fuerza el método
(lo mismo que `FLEXABLELIB_IMAGE`).
"""

from __future__ import annotations

import base64
import os
import re
from typing import Any, Callable, Iterable
from urllib.parse import urlparse

from flexablelib_components import IMAGE_EXTENSIONS, Image, ImageViewer

IMAGE_KEYS = re.compile(r"(^|_)(image|imagen|imagenes|img|foto|fotos|fotografia|logo|avatar|picture|photo|thumbnail|miniatura|firma|signature|evidence)", re.I)
_DATA_URL = re.compile(r"^data:image/[a-z0-9.+-]+;base64,", re.I)

Fetcher = Callable[[str], bytes | None]


def method() -> str | None:
    forced = (os.environ.get("IMPERIUM_IMAGEN") or "").strip().lower()
    return forced or None


def looks_like_image(value: Any, key: str = "") -> bool:
    """Una URL/ruta de imagen, una data URL, o un texto en un campo de imagen."""
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text or len(text) > 8_000_000:
        return False
    if _DATA_URL.match(text):
        return True
    path = urlparse(text).path.lower() if "://" in text else text.lower().split("?")[0]
    if path.endswith(IMAGE_EXTENSIONS):
        return text.startswith(("/", "http://", "https://", "api://", "file://")) or "/" in text
    return bool(key and IMAGE_KEYS.search(key) and text.startswith(("/", "http://", "https://", "api://")))


def image_values(value: Any, key: str = "") -> list[str]:
    """Las imágenes dentro de un valor (texto, lista, objeto `{url}` o JSON)."""
    if isinstance(value, str):
        if looks_like_image(value, key):
            return [value.strip()]
        if value.strip().startswith(("[", "{")):
            import json

            try:
                return image_values(json.loads(value), key)
            except ValueError:
                return []
        return []
    if isinstance(value, dict):
        for k in ("url", "src", "image_url", "image", "full", "path"):
            if isinstance(value.get(k), str) and looks_like_image(value[k], key or k):
                return [value[k].strip()]
        return []
    if isinstance(value, (list, tuple)):
        out: list[str] = []
        for item in value:
            out.extend(image_values(item, key))
        return out
    return []


def row_images(row: dict[str, Any], keys: Iterable[str] | None = None) -> list[tuple[str, str]]:
    """`[(fuente, alt)]` de las imágenes de una fila; `keys` limita las columnas."""
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    title = str(row.get("name") or row.get("nombre") or row.get("codigo") or row.get("_id") or "registro")
    for key in keys if keys is not None else row.keys():
        for src in image_values(row.get(key), str(key)):
            if src not in seen:
                seen.add(src)
                out.append((src, f"{key} de {title}"))
    return out


def decode_data_url(text: str) -> bytes | None:
    match = _DATA_URL.match(text.strip())
    if not match:
        return None
    try:
        return base64.b64decode(text.strip()[match.end():], validate=False)
    except ValueError:
        return None


def resolve_source(src: str, fetch: Fetcher | None) -> Any:
    """Lo que `Image` sabe abrir: bytes (data URL o bajada con token), o la
    URL/ruta tal cual cuando no hay con qué bajarla."""
    data = decode_data_url(src)
    if data is not None:
        return data
    if fetch is not None and (src.startswith(("/", "api://")) or src.startswith(("http://", "https://"))):
        try:
            got = fetch(src)
        except Exception:  # noqa: BLE001 - una imagen rota no tumba la pantalla
            got = None
        if got:
            return got
    return src


def image(src: str, alt: str, fetch: Fetcher | None = None, *, height: int | None = 12, width: int | None = None, focusable: bool = True) -> Image:
    """`Image` con alt (lo exige la auditoría) y el método forzado si lo hay."""
    widget = Image(resolve_source(src, fetch), alt=alt or "imagen", height=height, width=width, method=method(), caption=True, focusable=focusable, a11y_label=alt or "imagen")
    widget.imperium_src = src  # type: ignore[attr-defined]
    return widget


def viewer(images: list[tuple[str, str]], fetch: Fetcher | None = None, *, label: str = "Imágenes", height: int | None = 12) -> ImageViewer:
    """Visor de varias imágenes: ←/→ cambian, `f` ajusta, Enter/`o` abre."""
    resolved = [(resolve_source(src, fetch), alt) for src, alt in images]
    widget = ImageViewer(resolved, method=method(), a11y_label=label)
    for item in widget.items:
        item.height = height
    return widget
