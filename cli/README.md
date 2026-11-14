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
### TUI (`imperium` sin argumentos)

- **Menú por apps**: la barra lateral solo enseña las apps. Enter abre la app y su árbol de submenús, plegable a cualquier profundidad (→/Enter abre una carpeta, ← la cierra, `*` abre todo, Enter en una hoja abre la pantalla).
- **Pantallas de las apps**: las páginas `nox.*` del núcleo (`/api/m/subject-<app>/pages/<id>`) se dibujan con flexablelib, p. ej. «Ver tabla» de Herramientas: migas, buscador, resúmenes, tabla con fotos y paginador. Los botones con `href` navegan y los de `action` (`api://…`) escriben con confirmación. Si un componente no tiene equivalente en la terminal (`nox.login`, `nox.excel-import`, `nox.sidebar`), sale un aviso en su lugar.
- **Scroll en toda pantalla**: lo que no cabe hacia abajo se alcanza siempre. Tab lleva al siguiente campo y la vista baja sola; PgUp/PgDn, Ctrl+↑/↓, Ctrl+Inicio/Fin y la rueda la recorren; una barra a la derecha marca dónde vas. Una página sin campos (una ficha, un texto largo) toma el foco y se recorre con las flechas. Las listas (y «Ver tabla») son un `VStack` de flexablelib: la tabla llena el alto que sobra y el paginador nunca se sale. La barra lateral se recorta con muchas apps («▲/▼ n más») y PgUp/PgDn saltan en ella. Requiere flexablelib 3.7.0 o más nuevo.
- **Formularios en rejilla**: los campos se acomodan con la rejilla de `Form` de flexablelib (`min_column_width`, `FormCell`): 1 columna en terminal angosta, 2 en mediana, 3 en ancha. Respetan `column_span` (1, 2 o `full`) y `min_width` del núcleo; los campos anchos (textarea, JSON, Markdown, coordenadas, subtabla…) ocupan todo el renglón, como en el web.
- **Listas**: todas usan el formato view-list (buscador + tabla + paginador + estado) con paginación y búsqueda en el servidor.
- **Formularios**: cada campo usa su entrada de flexablelib (dinero, fecha, rango, hora, menú, radio, casillas, autocompletar con `ref`, JSON, Markdown, código, máscara de teléfono/RFC/CURP/CP, color, coordenadas, ícono, archivo/imagen, escáner que conserva el último código, firma a mano (se guarda como PNG), cronómetro, subtabla…). Los valores se juntan también dentro de pestañas, acordeones y subtablas.
- **Imágenes**: las fotos de productos, herramientas y evidencias se ven en la terminal (kitty, iTerm2, sixel; si no, bloques Unicode, braille o ASCII; y si nada de eso funciona, el texto alternativo). Se bajan con el token del perfil solo si son del mismo núcleo, y el token nunca sigue a una redirección (`read_source(headers=)` de flexablelib). El catálogo baja sus fotos al dibujarse (`image_headers`). `IMPERIUM_IMAGEN=half|sixel|kitty|iterm|ascii|link|none` fuerza el método.

| Tecla | Acción |
|---|---|
| F1 | Ayuda con todos los atajos |
| Ctrl+K | Paleta de comandos (todas las pantallas del menú) |
| Esc / Retroceso / Alt+← | Volver (historial) |
| `m` | Ir a las apps de la barra lateral · `h` Inicio |
| `/` o `f` | Buscar (en el servidor) |
| `n` / `p` | Página siguiente / anterior |
| `i` | Imágenes del registro o de la pantalla (←/→ cambian, `f` ajusta, Enter abre) |
| Enter | Abrir registro · F4 detalle · F2 editar · `a` alta |
| PgUp / PgDn · Ctrl+↑/↓ · Ctrl+Inicio/Fin | Desplazar la pantalla |
| `r` / F5 | Recargar · F6 caja · F9 masivo · `q` salir |

Mientras escribes en un campo, las letras no disparan atajos.

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
