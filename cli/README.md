# imperium-cli

Cliente de terminal de Imperium. Usa la **misma cuenta, identidad y permisos que la GUI**.

```bash
imperium iniciar-sesion --url https://ejemplo.codice-progressio.online --usuario ana@empresa --dispositivo laptop
imperium estado --json
imperium          # TUI
```

La imagen `ghcr.io/opus-perpetuus/imperium-cli` se publica con la misma versión que el núcleo. En el servidor, el comando anfitrión `imperium` (instalado por `update-v13`) ejecuta `actualizar`, `doctor` y `logs` en el host, y el resto dentro del contenedor `cli`.

## Fase 2

```bash
imperium iniciar-sesion --url https://servidor --codigo-dispositivo   # RFC 8628, sin contraseña en la terminal
imperium recurso products listar --buscar tornillo
imperium recurso products crear --campo name=Tornillo --dry-run
imperium inventario existencias|kardex|traslado|ajuste|conteo …
imperium ventas pedidos listar|ver · imperium ventas reporte --desde 2026-11-01
imperium pos sesiones listar|cerrar · imperium pos reimprimir --folio V9
imperium masivo importar|editar|borrar <recurso> --desde archivo.csv|xlsx   # plan por defecto; --yes ejecuta
imperium masivo --continuar <id>
```

`masivo borrar` hace un respaldo del núcleo y espera a que termine antes de borrar.
TUI: Ctrl+K paleta, Esc volver, `/` o `f` filtrar, `a` alta, F1 ayuda, F2 editar, F4 detalle, F9 masivo.

## Fase 3: caja, perfiles remotos, MCP y SSH

### Instalar con pipx

```bash
pipx install "imperium-cli[keyring] @ git+https://github.com/codice-progressio/imperium-SIC-ayuntamiento-zapotlanejo#subdirectory=modular/cli"
imp --version   # alias corto de `imperium`
```

Con `keyring` instalado el token va al llavero del sistema (`IMPERIUM_KEYRING=0` lo desactiva); sin él queda en `~/.config/imperium/config.json` con modo `0600`.

### Perfiles (varias instancias)

```bash
imperium perfiles agregar --nombre trigal --url https://trigal.example --usar
imperium perfiles listar | usar <nombre> | probar | eliminar <nombre>
imperium --perfil trigal estado
```

### Caja con lector de códigos

```bash
imperium pos caja                          # escáner HID: un código por línea, 3*código, "-" quita, vacío cobra
imperium pos caja --codigo 7501 --item 2*TUB-1 --pago efectivo --efectivo 500 --yes --reimprimir
imperium pos caja --codigo 7501 --dry-run --json
```

Busca en `GET /api/products?codigo=…` y registra en `POST /api/pos-tickets` (`ticket_type: VENTA`) en la sesión POS abierta o `--sesion`. En la TUI: `F6`.

### MCP local (stdio)

```json
{ "mcpServers": { "imperium": { "command": "imperium", "args": ["--perfil", "trigal", "mcp"] } } }
```

Herramientas de solo lectura (`imperium_estado`, `imperium_recurso_listar`, `imperium_recurso_ver`, `imperium_inventario_existencias`, `imperium_ventas_reporte`, `imperium_pos_producto`) con los permisos de la cuenta del perfil.

### SSH con ForceCommand

```text
# /etc/ssh/sshd_config
Match User caja
    ForceCommand /home/caja/.local/bin/imperium ssh-shell
    PermitTTY yes
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
```

`ssh caja@host` abre la TUI restringida (sin asistente masivo); `ssh caja@host "estado --json"` corre solo subcomandos de la lista blanca. Se rechazan metacaracteres de shell, `--perfil`, comandos de host (`doctor`, `actualizar`, `logs`), `perfiles`, `masivo` y `mcp`.
