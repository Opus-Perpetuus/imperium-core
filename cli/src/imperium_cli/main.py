from __future__ import annotations

import argparse
import sys
from collections.abc import Callable

from .commands import apps, caja, estado, host, inventario, masivo, mcp, perfiles, recurso, respaldos, sesion, ssh_shell, usuarios, ventas
from .exits import CliError, USO
from .version import cli_version


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="imperium",
        description="Opera Imperium desde la terminal con la misma cuenta que la GUI.",
    )
    parser.add_argument("--json", action="store_true", help="Salida en JSON (para scripts).")
    parser.add_argument("--perfil", help="Nombre del perfil local.")
    parser.add_argument("--accesible", action="store_true", help="Modo lineal para lector de pantalla.")
    parser.add_argument("--version", action="store_true", help="Muestra la versión de la CLI y sale.")
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument("--json", action="store_true", help="Salida en JSON (para scripts).")
    shared.add_argument("--perfil", help="Nombre del perfil local.")
    shared.add_argument("--accesible", action="store_true", help="Modo lineal para lector de pantalla.")
    sub = parser.add_subparsers(dest="comando")

    p_login = sub.add_parser("iniciar-sesion", parents=[shared], help="Inicia sesión con tu usuario de la GUI y guarda un token CLI.")
    p_login.add_argument("--url", required=False)
    p_login.add_argument("--usuario")
    p_login.add_argument("--contrasena")
    p_login.add_argument("--dispositivo")
    p_login.add_argument("--codigo-dispositivo", action="store_true", help="Aprueba en el navegador (RFC 8628); sin contraseña en la terminal.")
    p_login.set_defaults(handler=sesion.iniciar_sesion)

    p_logout = sub.add_parser("cerrar-sesion", parents=[shared], help="Revoca el token CLI del perfil activo.")
    p_logout.set_defaults(handler=sesion.cerrar_sesion)

    p_estado = sub.add_parser("estado", parents=[shared], help="Salud del núcleo y resumen de la sesión.")
    p_estado.set_defaults(handler=estado.estado)

    p_ver = sub.add_parser("version", parents=[shared], help="Versión de la CLI y del núcleo.")
    p_ver.add_argument("--url")
    p_ver.set_defaults(handler=estado.version_cmd)

    p_apps = sub.add_parser("apps", parents=[shared], help="Listar, instalar, actualizar o desinstalar apps.")
    apps_sub = p_apps.add_subparsers(dest="apps_cmd", required=True)
    p_al = apps_sub.add_parser("listar", parents=[shared])
    p_al.set_defaults(handler=apps.listar)
    for name, fn in (("instalar", apps.instalar), ("desinstalar", apps.desinstalar), ("actualizar", apps.actualizar), ("motivo", apps.motivo)):
        p = apps_sub.add_parser(name, parents=[shared])
        if name != "actualizar":
            p.add_argument("slug")
        else:
            p.add_argument("slug", nargs="?")
        if name != "motivo":
            p.add_argument("--dry-run", action="store_true")
            p.add_argument("--si", "--yes", dest="yes", action="store_true")
        p.set_defaults(handler=fn)

    p_res = sub.add_parser("respaldos", parents=[shared], help="Respaldos del gestor de base de datos.")
    res_sub = p_res.add_subparsers(dest="res_cmd", required=True)
    p_rl = res_sub.add_parser("listar", parents=[shared])
    p_rl.set_defaults(handler=respaldos.listar)
    p_rc = res_sub.add_parser("crear", parents=[shared])
    p_rc.add_argument("--etiqueta")
    p_rc.add_argument("--dry-run", action="store_true")
    p_rc.add_argument("--si", dest="yes", action="store_true")
    p_rc.set_defaults(handler=respaldos.crear)
    p_rv = res_sub.add_parser("verificar", parents=[shared])
    p_rv.add_argument("id")
    p_rv.set_defaults(handler=respaldos.verificar)
    p_rd = res_sub.add_parser("descargar", parents=[shared])
    p_rd.add_argument("id")
    p_rd.add_argument("--salida")
    p_rd.add_argument("--dry-run", action="store_true")
    p_rd.set_defaults(handler=respaldos.descargar)

    p_us = sub.add_parser("usuarios", parents=[shared], help="Usuarios y grupos (con el ACL de tu cuenta).")
    us_sub = p_us.add_subparsers(dest="us_cmd", required=True)
    p_ul = us_sub.add_parser("listar", parents=[shared])
    p_ul.set_defaults(handler=usuarios.listar)
    p_uv = us_sub.add_parser("ver", parents=[shared])
    p_uv.add_argument("id")
    p_uv.set_defaults(handler=usuarios.ver)
    p_uc = us_sub.add_parser("crear", parents=[shared])
    p_uc.add_argument("--nombre")
    p_uc.add_argument("--correo")
    p_uc.add_argument("--dry-run", action="store_true")
    p_uc.add_argument("--si", dest="yes", action="store_true")
    p_uc.set_defaults(handler=usuarios.crear)
    p_ud = us_sub.add_parser("desactivar", parents=[shared])
    p_ud.add_argument("id")
    p_ud.add_argument("--dry-run", action="store_true")
    p_ud.add_argument("--si", dest="yes", action="store_true")
    p_ud.set_defaults(handler=usuarios.desactivar)
    p_ur = us_sub.add_parser("reset-password", parents=[shared])
    p_ur.add_argument("id")
    p_ur.add_argument("--enviar-correo", action="store_true")
    p_ur.add_argument("--dry-run", action="store_true")
    p_ur.add_argument("--si", dest="yes", action="store_true")
    p_ur.set_defaults(handler=usuarios.reset_password)
    p_ub = us_sub.add_parser("desbloquear-login", parents=[shared])
    p_ub.add_argument("id")
    p_ub.set_defaults(handler=usuarios.desbloquear)
    p_ug = us_sub.add_parser("grupos", parents=[shared])
    p_ug.set_defaults(handler=usuarios.grupos)

    p_ins = sub.add_parser("instancia", parents=[shared], help="Información de la instancia del perfil.")
    ins_sub = p_ins.add_subparsers(dest="ins_cmd", required=True)
    p_ii = ins_sub.add_parser("info", parents=[shared])
    p_ii.set_defaults(handler=perfiles.instancia)

    p_per = sub.add_parser("perfiles", parents=[shared], help="Perfiles locales (URL y token).")
    per_sub = p_per.add_subparsers(dest="per_cmd", required=True)
    p_pl = per_sub.add_parser("listar", parents=[shared])
    p_pl.set_defaults(handler=perfiles.listar)
    p_pu = per_sub.add_parser("usar", parents=[shared])
    p_pu.add_argument("nombre")
    p_pu.set_defaults(handler=perfiles.usar)
    p_pa = per_sub.add_parser("agregar", parents=[shared])
    p_pa.add_argument("--nombre", required=True)
    p_pa.add_argument("--url", required=True)
    p_pa.add_argument("--usar", action="store_true")
    p_pa.set_defaults(handler=perfiles.agregar)
    for name, fn in (("borrar", perfiles.borrar), ("eliminar", perfiles.eliminar)):
        p_pb = per_sub.add_parser(name, parents=[shared])
        p_pb.add_argument("nombre")
        p_pb.set_defaults(handler=fn)
    p_pp = per_sub.add_parser("probar", parents=[shared], help="Prueba URL y token del perfil.")
    p_pp.set_defaults(handler=perfiles.probar)

    def write(p):
        p.add_argument("--dry-run", action="store_true", help="Muestra lo que haría sin cambiar nada.")
        p.add_argument("--si", "--yes", dest="yes", action="store_true", help="No pide confirmación.")
        return p

    p_rec = sub.add_parser("recurso", parents=[shared], help="CRUD genérico de cualquier recurso visible en /api/meta.")
    p_rec.add_argument("nombre", nargs="?", help="Recurso (p. ej. products); vacío lista los recursos.")
    p_rec.add_argument("accion", nargs="?", default="listar", choices=["listar", "ver", "crear", "editar", "borrar"])
    p_rec.add_argument("id", nargs="?")
    p_rec.add_argument("--campo", action="append", metavar="CLAVE=VALOR")
    p_rec.add_argument("--datos", help="Objeto JSON con los valores.")
    p_rec.add_argument("--buscar")
    p_rec.add_argument("--filtro", action="append", metavar="CAMPO=VALOR")
    p_rec.add_argument("--pagina", type=int, default=1)
    p_rec.add_argument("--limite", type=int, default=20)
    write(p_rec)
    p_rec.set_defaults(handler=recurso.recurso)

    p_inv = sub.add_parser("inventario", parents=[shared], help="Existencias, kárdex, traslados, ajustes y conteos.")
    inv = p_inv.add_subparsers(dest="inv_cmd", required=True)
    p = inv.add_parser("existencias", parents=[shared])
    p.add_argument("--producto"); p.add_argument("--ubicacion"); p.add_argument("--buscar"); p.add_argument("--limite", type=int, default=50)
    p.set_defaults(handler=inventario.existencias)
    p = inv.add_parser("kardex", parents=[shared])
    p.add_argument("producto"); p.add_argument("--desde"); p.add_argument("--hasta")
    p.set_defaults(handler=inventario.kardex)
    p = write(inv.add_parser("traslado", parents=[shared]))
    p.add_argument("--producto"); p.add_argument("--origen", required=True); p.add_argument("--destino", required=True)
    p.add_argument("--cantidad", type=float); p.add_argument("--lote"); p.add_argument("--almacen-completo", action="store_true")
    p.set_defaults(handler=inventario.traslado)
    p = write(inv.add_parser("ajuste", parents=[shared]))
    p.add_argument("--tipo", choices=["entrada", "salida"], required=True); p.add_argument("--producto", required=True)
    p.add_argument("--cantidad", type=float, required=True); p.add_argument("--ubicacion"); p.add_argument("--motivo", required=True)
    p.set_defaults(handler=inventario.ajuste)
    p_con = inv.add_parser("conteo", parents=[shared])
    con = p_con.add_subparsers(dest="conteo_cmd", required=True)
    p = con.add_parser("listar", parents=[shared]); p.add_argument("--buscar"); p.add_argument("--limite", type=int, default=50)
    p.set_defaults(handler=inventario.conteo)
    p = con.add_parser("ver", parents=[shared]); p.add_argument("id"); p.set_defaults(handler=inventario.conteo)
    p = write(con.add_parser("aplicar", parents=[shared])); p.add_argument("id"); p.set_defaults(handler=inventario.conteo)

    p_ven = sub.add_parser("ventas", parents=[shared], help="Pedidos y reporte de ventas.")
    ven = p_ven.add_subparsers(dest="ventas_cmd", required=True)
    p_ped = ven.add_parser("pedidos", parents=[shared])
    ped = p_ped.add_subparsers(dest="pedidos_cmd", required=True)
    p = ped.add_parser("listar", parents=[shared]); p.add_argument("--buscar"); p.add_argument("--estado"); p.add_argument("--limite", type=int, default=50)
    p.set_defaults(handler=ventas.pedidos)
    p = ped.add_parser("ver", parents=[shared]); p.add_argument("id"); p.set_defaults(handler=ventas.pedidos)
    p = ven.add_parser("reporte", parents=[shared]); p.add_argument("--desde"); p.add_argument("--hasta"); p.add_argument("--sesion")
    p.set_defaults(handler=ventas.reporte)

    p_pos = sub.add_parser("pos", parents=[shared], help="Sesiones POS y reimpresión de tickets.")
    pos = p_pos.add_subparsers(dest="pos_cmd", required=True)
    p_ses = pos.add_parser("sesiones", parents=[shared])
    ses = p_ses.add_subparsers(dest="sesiones_cmd", required=True)
    p = ses.add_parser("listar", parents=[shared]); p.add_argument("--abiertas", action="store_true"); p.add_argument("--limite", type=int, default=50)
    p.set_defaults(handler=ventas.sesiones)
    p = write(ses.add_parser("cerrar", parents=[shared])); p.add_argument("ids", nargs="*"); p.add_argument("--motivo"); p.add_argument("--forzar", action="store_true")
    p.set_defaults(handler=ventas.sesiones)
    p = write(pos.add_parser("reimprimir", parents=[shared])); p.add_argument("--folio"); p.add_argument("--id"); p.add_argument("--tipo", choices=["ticket", "remision"], default="ticket")
    p.set_defaults(handler=ventas.reimprimir)
    p = write(pos.add_parser("caja", parents=[shared], help="Venta de mostrador con lector de códigos."))
    p.add_argument("--codigo", action="append", metavar="CODIGO", help="Código escaneado (repetible; 3*CODIGO para cantidad).")
    p.add_argument("--item", action="append", metavar="CODIGOxCANT", help="Artículo con cantidad (repetible).")
    p.add_argument("--pago", choices=sorted(caja.PAGOS), default="efectivo")
    p.add_argument("--efectivo", type=float, help="Efectivo recibido (calcula el cambio).")
    p.add_argument("--sesion", help="Id de la sesión POS (por defecto la abierta).")
    p.add_argument("--reimprimir", action="store_true", help="Registra la impresión del ticket al terminar.")
    p.set_defaults(handler=caja.caja)

    p_mas = sub.add_parser("masivo", parents=[shared], help="Importar, editar o borrar en lote desde CSV/XLSX (dry-run por defecto).")
    p_mas.add_argument("operacion", nargs="?", choices=["importar", "editar", "borrar"])
    p_mas.add_argument("recurso", nargs="?")
    p_mas.add_argument("--desde", help="Archivo .csv o .xlsx.")
    p_mas.add_argument("--mapeo", action="append", metavar="COLUMNA=CAMPO")
    p_mas.add_argument("--coincidir", help="Campo para encontrar registros al editar (por defecto _id).")
    p_mas.add_argument("--lote", type=int, default=100)
    p_mas.add_argument("--reporte", help="Ruta del reporte CSV.")
    p_mas.add_argument("--continuar", metavar="ID", help="Reanuda un trabajo cortado.")
    write(p_mas)
    p_mas.set_defaults(handler=masivo.masivo)

    p_mcp = sub.add_parser("mcp", parents=[shared], help="Servidor MCP local por stdio con el perfil activo (solo lectura).")
    p_mcp.set_defaults(handler=mcp.mcp)
    p_ssh = sub.add_parser("ssh-shell", parents=[shared], help="Entrada para ForceCommand de sshd (lista blanca).")
    p_ssh.set_defaults(handler=ssh_shell.ssh_shell)

    p_doc = sub.add_parser("doctor", parents=[shared], help="Diagnóstico del host (wrapper root/deploy).")
    p_doc.set_defaults(handler=host.doctor)
    p_upd = sub.add_parser("actualizar", parents=[shared], help="Actualiza el servidor (wrapper root/deploy).")
    p_upd.set_defaults(handler=host.actualizar)
    p_logs = sub.add_parser("logs", parents=[shared], help="Logs del host (wrapper root/deploy).")
    p_logs.add_argument("destino", nargs="?", default="contenedores")
    p_logs.set_defaults(handler=host.logs)

    return parser


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as err:
        code = err.code
        return USO if code not in (0, None) else 0
    if getattr(args, "version", False) and not args.comando:
        sys.stdout.write(f"imperium {cli_version()}\n")
        return 0
    handler: Callable | None = getattr(args, "handler", None)
    if handler is None:
        return _launch_tui(args)
    try:
        return int(handler(args) or 0)
    except CliError as err:
        stream = sys.stderr
        if getattr(args, "json", False):
            import json

            json.dump({"ok": False, "error": err.message, "code": err.code, "status": err.status}, stream, ensure_ascii=False)
            stream.write("\n")
        else:
            stream.write(err.message + "\n")
        return int(err.code)
    except KeyboardInterrupt:
        sys.stderr.write("Cancelado.\n")
        return USO


def _launch_tui(args) -> int:
    from . import config
    from .tui.app import run_tui

    data = config.load()
    profile = config.get_profile(data, getattr(args, "perfil", None))
    run_tui(profile=profile, accesible=bool(getattr(args, "accesible", False)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
