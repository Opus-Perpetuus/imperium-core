"""Menú de la TUI: `/api/auth/menus` (lista plana con `parent_id`) → árbol.

La barra lateral solo enseña las apps (las raíces). Al abrir una app se ve su
árbol de submenús, plegable a cualquier profundidad (carpetas dentro de
carpetas, como «Inventario › Surtido › Por surtir»).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class MenuNode:
    id: str
    name: str
    path: str = ""
    icon: str = ""
    order: float = 0.0
    resources: list[str] = field(default_factory=list)
    children: list["MenuNode"] = field(default_factory=list)

    @property
    def is_folder(self) -> bool:
        return bool(self.children)

    def leaves(self, trail: tuple[str, ...] = ()) -> list[tuple[tuple[str, ...], "MenuNode"]]:
        """Hojas abribles con su ruta de nombres (para la paleta de comandos)."""
        here = trail + (self.name,)
        if not self.children:
            return [(here, self)] if self.path else []
        out: list[tuple[tuple[str, ...], MenuNode]] = []
        if self.path:
            out.append((here, self))
        for child in self.children:
            out.extend(child.leaves(here))
        return out


def _order(menu: dict[str, Any]) -> float:
    try:
        return float(menu.get("order") or 0)
    except (TypeError, ValueError):
        return 0.0


def build_tree(menus: list[dict[str, Any]]) -> list[MenuNode]:
    """Raíces ordenadas (order, nombre). Un padre que no llegó (sin permiso o
    inactivo) deja a su hijo como raíz en lugar de perderlo; los ciclos se cortan."""
    nodes: dict[str, MenuNode] = {}
    parents: dict[str, str] = {}
    for menu in menus:
        if not isinstance(menu, dict) or menu.get("is_active") is False:
            continue
        name = str(menu.get("name") or "").strip()
        ident = str(menu.get("_id") or menu.get("id") or menu.get("_ref") or name)
        if not name or ident in nodes:
            continue
        resources = [str(r) for r in menu.get("resources") or [] if r] if isinstance(menu.get("resources"), list) else []
        nodes[ident] = MenuNode(
            id=ident,
            name=name,
            path=str(menu.get("path") or ""),
            icon=str(menu.get("icon") or ""),
            order=_order(menu),
            resources=resources,
        )
        parent = str(menu.get("parent_id") or "")
        if parent:
            parents[ident] = parent
    roots: list[MenuNode] = []
    for ident, node in nodes.items():
        parent = parents.get(ident)
        if parent and parent in nodes and not _creates_cycle(ident, parent, parents):
            nodes[parent].children.append(node)
        else:
            roots.append(node)

    def sort(items: list[MenuNode]) -> list[MenuNode]:
        items.sort(key=lambda n: (n.order, n.name.lower()))
        for item in items:
            sort(item.children)
        return items

    return sort(roots)


def _creates_cycle(ident: str, parent: str, parents: dict[str, str]) -> bool:
    seen = {ident}
    node = parent
    while node:
        if node in seen:
            return True
        seen.add(node)
        node = parents.get(node, "")
    return False


def tree_data(node: MenuNode) -> tuple[tuple[str, Any], dict[tuple[str, ...], MenuNode]]:
    """Datos para `flexablelib_components.Tree` y el índice ruta → nodo.

    Las carpetas son `(nombre, (nombre, [hijos]))` y las hojas `(nombre, None)`. Si dos
    hermanos se llaman igual, el segundo lleva « (2)» para no chocar en la ruta.
    """
    index: dict[tuple[str, ...], MenuNode] = {}

    def walk(items: list[MenuNode], trail: tuple[str, ...]) -> list[tuple[str, Any]]:
        out: list[tuple[str, Any]] = []
        used: dict[str, int] = {}
        for item in items:
            used[item.name] = used.get(item.name, 0) + 1
            label = item.name if used[item.name] == 1 else f"{item.name} ({used[item.name]})"
            path = trail + (label,)
            index[path] = item
            # Tree trata `(nombre, [hijos])` como nodo y una lista suelta como
            # arreglo («[0]», «[1]»): la carpeta lleva su nodo completo.
            out.append((label, (label, walk(item.children, path)) if item.children else None))
        return out

    return (node.name, walk(node.children, ())), index


def sidebar_items(roots: list[MenuNode], on_open: Callable[[MenuNode], Any]) -> list[dict[str, Any]]:
    """Solo las apps: una entrada por raíz; Enter abre la app (su árbol)."""
    return [
        {"label": root.name, "action": (lambda r=root: on_open(r)), "app": True}
        for root in roots
    ]


def find_by_path(roots: list[MenuNode], path: str) -> MenuNode | None:
    wanted = "/" + path.strip("/")
    stack = list(roots)
    while stack:
        node = stack.pop(0)
        if node.path and "/" + node.path.strip("/") == wanted:
            return node
        stack.extend(node.children)
    return None


def trail_for(roots: list[MenuNode], path: str) -> list[str]:
    """Nombres desde la app hasta la hoja de `path` («Herramientas», «Ver tabla»); [] si no está."""
    wanted = "/" + path.split("?")[0].strip("/").removeprefix("internal/")

    def walk(items: list[MenuNode], trail: list[str]) -> list[str]:
        for node in items:
            here = trail + [node.name]
            if node.path and "/" + node.path.strip("/") == wanted:
                return here
            found = walk(node.children, here)
            if found:
                return found
        return []

    return walk(roots, [])
