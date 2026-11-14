"""Backend falso con lo que manda un núcleo real: menús anidados, `/api/meta`,
páginas `nox.*` de Herramientas («Ver tabla») con fotos, y un `feature-shell`."""

from __future__ import annotations

from urllib.parse import parse_qsl

from flexablelib._images import Bitmap, encode_png

from imperium_cli.tui.app import Backend


def png() -> bytes:
    data = bytearray()
    for y in range(4):
        for x in range(4):
            data += bytes((255 * (x % 2), 120, 255 * (y % 2), 255))
    return encode_png(Bitmap(4, 4, bytes(data)))


MENUS = [
    {"_id": "r-alm", "name": "Almacén", "order": 1},
    {"_id": "inv", "name": "Inventario", "parent_id": "r-alm", "order": 1},
    {"_id": "surt", "name": "Surtido", "parent_id": "inv", "order": 2},
    {"_id": "por", "name": "Por surtir", "path": "/pedidos/surtir", "parent_id": "surt"},
    {"_id": "prod", "name": "Productos", "path": "/products", "parent_id": "inv", "order": 1},
    {"_id": "r-herr", "name": "Herramientas", "order": 2},
    {"_id": "h1", "name": "Tablas personalizadas", "path": "/herr-tablas", "parent_id": "r-herr", "order": 10},
    {"_id": "h2", "name": "Ver tabla", "path": "/herr-tabla", "parent_id": "r-herr", "order": 11},
    {"_id": "h3", "name": "Jornada en curso", "path": "/herr-jornada", "parent_id": "r-herr", "order": 12},
    {"_id": "r-ven", "name": "Ventas", "path": "/pedidos", "order": 3},
    {"_id": "off", "name": "Inactivo", "path": "/x", "parent_id": "r-ven", "is_active": False},
]

META = [
    {
        "resource": "products",
        "path": "/products",
        "name": "Productos",
        "subject": "almacen",
        "permissions": {"read": True, "create": True, "update": True, "delete": True},
        "fields": [
            {"name": "name", "label": "Nombre", "component": "input-text", "type": "string", "required": True},
            {"name": "codigo", "label": "Código", "component": "input-text", "type": "string"},
            {"name": "precio", "label": "Precio", "component": "input-money", "type": "number"},
            {"name": "existencia", "label": "Existencia", "component": "input-number", "type": "number"},
            {"name": "is_active", "label": "Activo", "component": "input-checkbox", "type": "boolean"},
            {"name": "datos", "label": "Datos", "component": "input-json", "type": "json"},
            {"name": "unidad", "label": "Unidad", "component": "input-menu", "type": "string", "options": [{"value": "pz", "label": "Pieza"}, {"value": "kg", "label": "Kilo"}, {"value": "lt", "label": "Litro"}, {"value": "m", "label": "Metro"}]},
            {"name": "estado", "label": "Estado", "component": "input-text", "type": "string", "options": [{"value": "a", "label": "Alta"}, {"value": "b", "label": "Baja"}]},
            {"name": "fecha_alta", "label": "Fecha", "component": "input-date", "type": "string"},
            {"name": "description", "label": "Descripción", "component": "input-textarea", "type": "string"},
            {"name": "icono", "label": "Ícono", "component": "input-icon", "type": "string"},
            {"name": "image", "label": "Imagen", "component": "input-text", "type": "string"},
            {"name": "categoria", "label": "Categoría", "component": "input-text", "type": "string", "ref": "product-category"},
        ],
        "list_columns": [{"name": "codigo", "label": "Código"}, {"name": "name", "label": "Nombre"}, {"name": "image", "label": "Imagen"}],
    },
    {"resource": "pedidos", "path": "/pedidos", "name": "Pedidos", "subject": "ventas", "permissions": {"read": True}, "fields": [], "list_columns": []},
    {"resource": "herr-tabla", "path": "/herr-tabla", "name": "Ver tabla", "subject": "herramientas", "permissions": {"read": True}, "fields": [], "list_columns": []},
    {"resource": "herr-tablas", "path": "/herr-tablas", "name": "Tablas personalizadas", "subject": "herramientas", "permissions": {"read": True}, "fields": [], "list_columns": []},
    {"resource": "herr-jornada", "path": "/herr-jornada", "name": "Jornada en curso", "subject": "herramientas", "permissions": {"read": True}, "fields": [], "list_columns": []},
]

PRODUCTS = [
    {"_id": f"p{i:02d}", "codigo": f"P{i}", "name": f"Producto {i}", "image": f"/api/files/p{i}.png" if i % 2 else "", "precio": 10 * i}
    for i in range(1, 46)
]


def nodo(component, props=None, children=None, text=None):
    out = {"component": component, "props": props or {}}
    if children:
        out["children"] = children
    if text:
        out["text"] = text
    return out


def herr_inicio():
    """«Ver tabla» sin `id`: tarjetas de las tablas (como `pagina_inicio`)."""
    tarjeta = nodo("nox.card", {"title": "Préstamos"}, [
        nodo("nox.markdown-view", {"content": "3 columnas · 2 registros"}),
        nodo("nox.toolbar", {}, [
            nodo("nox.button", {"href": "/internal/herr-tabla?id=tabla_1", "text": "Abrir"}, text="Abrir"),
            nodo("nox.button", {"href": "/internal/herr-registro?tabla=tabla_1", "text": "Capturar"}, text="Capturar"),
        ]),
    ])
    return {"id": "herramientas.herr-tabla", "owner": "subject-herramientas", "title": "Ver tabla", "page": nodo("nox.page", {}, [
        nodo("nox.markdown-view", {"content": "Anota lo que quieras en tablas a tu medida."}),
        nodo("nox.stack", {"layout": "grid"}, [tarjeta]),
    ])}


def herr_tabla(query: str):
    """«Ver tabla» con `id`: migas, acciones, buscador, resúmenes, tabla con fotos y paginador."""
    params = dict(parse_qsl(query))
    page = int(params.get("page") or 1)
    q = params.get("q", "")
    filas = [
        {"_id": f"r{i}", "nombre": f"Ana {i}", "monto": f"${i * 100}", "foto__mini": f"/api/m/subject-herramientas/files/m{i}.png", "foto__full": [f"/api/m/subject-herramientas/files/f{i}.png", f"data:image/png;base64,{__import__('base64').b64encode(png()).decode()}"], "_href": f"/internal/herr-registro?tabla=tabla_1&id=r{i}"}
        for i in range((page - 1) * 25 + 1, page * 25 + 1)
        if not q or q in f"Ana {i}"
    ]
    return {"id": "herramientas.herr-tabla", "owner": "subject-herramientas", "title": "Préstamos", "page": nodo("nox.page", {}, [
        nodo("nox.toolbar", {"block": "migas"}, [nodo("nox.link", {"href": "/internal/herr-tabla", "text": "Mis tablas"}, text="Mis tablas"), nodo("nox.link", {"href": "/internal/herr-tabla?id=tabla_1", "text": "Préstamos"}, text="Préstamos")]),
        nodo("nox.toolbar", {}, [nodo("nox.button", {"href": "/internal/herr-registro?tabla=tabla_1", "variant": "primary", "text": "Nuevo registro"}, text="Nuevo registro")]),
        nodo("nox.search", {"label": "Buscar en los registros", "value": q}),
        nodo("nox.stats", {"items": [{"id": "t", "label": "Total prestado", "value": "$4,500"}, {"id": "n", "label": "Registros", "value": "60"}]}),
        nodo("nox.table", {
            "columns": [
                {"key": "nombre", "label": "Nombre"},
                {"key": "monto", "label": "Monto"},
                {"key": "foto", "label": "Foto", "image_key": "foto__mini", "image_full_key": "foto__full"},
            ],
            "rows": filas,
        }, text="Sin registros"),
        nodo("nox.paginator", {"total": 60, "page_size": 25, "page": page}),
    ])}


def herr_jornada():
    """Una pantalla con casi todo: detalle, alertas, pestañas, línea de tiempo y un formulario."""
    form = nodo("nox.form", {"method": "POST", "action": "api://herr-jornadas/cerrar", "then": "herramientas.herr-jornada?cerrada=1", "title": "Cerrar jornada"}, [
        nodo("nox.input-hidden", {"name": "jornada_id", "value": "j1"}),
        nodo("nox.input-money", {"name": "efectivo", "label": "Efectivo contado", "required": True, "value": 500}),
        nodo("nox.input-menu", {"name": "responsable", "label": "Responsable", "options": [{"value": "ana", "label": "Ana"}, {"value": "luis", "label": "Luis"}], "value": "ana"}),
        nodo("nox.input-textarea", {"name": "nota", "label": "Nota"}),
        nodo("nox.input-image", {"name": "evidencia", "label": "Evidencia", "value": "/api/m/subject-herramientas/files/e.png"}),
        nodo("nox.input-subtable", {"name": "gastos", "label": "Gastos", "columns": [{"key": "concepto", "label": "Concepto"}, {"key": "monto", "label": "Monto"}], "value": [{"concepto": "Gas", "monto": 100}]}),
    ])
    return {"id": "herramientas.herr-jornada", "owner": "subject-herramientas", "title": "Jornada en curso", "page": nodo("nox.page", {}, [
        nodo("nox.alert", {"text": "Jornada abierta desde las 8:00", "kind": "info"}),
        nodo("nox.detail", {"items": [{"label": "Estado", "value": "Abierta"}, {"label": "Foto", "value": "/api/m/subject-herramientas/files/j.png"}]}),
        nodo("nox.tabs", {"items": [{"id": "a", "label": "Resumen"}, {"id": "b", "label": "Historial"}]}, [
            nodo("nox.markdown-view", {"content": "**Todo en orden**"}),
            nodo("nox.timeline", {"items": [{"when": "08:00", "title": "Abrió"}, {"when": "12:00", "title": "Gasto"}]}),
        ]),
        nodo("nox.collapsible", {"title": "Más"}, [nodo("nox.badge", {}, text="nuevo"), nodo("nox.tag", {}, text="caja")]),
        nodo("nox.image-viewer", {"images": ["/api/m/subject-herramientas/files/a.png", "/api/m/subject-herramientas/files/b.png"], "alt": "Fotos de la jornada"}),
        nodo("nox.button", {"method": "POST", "action": "api://herr-jornadas/pausar", "confirm": "¿Pausar?", "text": "Pausar"}, text="Pausar"),
        form,
    ])}


def herr_tablas_shell():
    return {"id": "herramientas.herr-tablas", "owner": "subject-herramientas", "title": "Tablas personalizadas", "page": nodo("nox.page", {}, [
        nodo("nox.feature-shell", {
            "basePath": "herr-tablas",
            "view": {"title": "Tablas personalizadas", "subtitle": "Bases de datos a medida."},
            "data": {"list": "api://m/subject-herramientas/herr-tablas"},
            "table": {"columns": [{"key": "name", "label": "Nombre"}, {"key": "icono", "label": "Ícono"}]},
            "form": {"fields": [{"name": "name", "component": "input-text", "label": "Nombre", "required": True}]},
        }),
    ])}


class HerrBackend(Backend):
    def __init__(self):
        super().__init__({"url": "http://nucleo", "token": "icli_X", "user": {"email": "ana@local"}})
        self.calls: list[tuple] = []
        self.writes: list[tuple] = []

    def health(self):
        return {"version": "13.125.3", "db": True}

    def menus(self):
        return MENUS

    def meta(self):
        return META

    def registry_leaves(self):
        return []

    def subject_pages(self, slug):
        if slug == "herramientas":
            return [{"id": "herramientas.herr-tabla", "path": "herr-tabla"}, {"id": "herramientas.herr-tablas", "path": "herr-tablas"}, {"id": "herramientas.herr-jornada", "path": "herr-jornada"}]
        return []

    def page(self, slug, page_id, query=""):
        self.calls.append(("page", slug, page_id, query))
        if page_id == "herramientas.herr-tabla":
            return herr_tabla(query) if "id=" in query else herr_inicio()
        if page_id == "herramientas.herr-jornada":
            return herr_jornada()
        if page_id == "herramientas.herr-tablas":
            return herr_tablas_shell()
        return None

    def list_page(self, meta, page=1, size=20, term=""):
        self.calls.append(("list", meta["resource"], page, size, term))
        if meta["resource"] != "products":
            return [], 0
        rows = [r for r in PRODUCTS if term.lower() in r["name"].lower()]
        return rows[(page - 1) * size : page * size], len(rows)

    def list_source(self, path, page=1, size=20, term=""):
        self.calls.append(("source", path, page, size, term))
        if path.endswith("/product-category"):
            return [{"_id": "c1", "name": "Bebidas"}], 1
        return [{"id": "tabla_1", "name": "Préstamos", "icono": "fa-hand-holding-dollar"}], 1

    def fetch_bytes(self, src):
        self.calls.append(("img", src))
        return png()

    def write(self, method, path, body):
        self.writes.append((method, path, body))
        return "Guardado"
