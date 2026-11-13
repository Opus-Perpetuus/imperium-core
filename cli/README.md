# imperium-cli

Cliente de terminal de Imperium. Usa la **misma cuenta, identidad y permisos que la GUI**.

```bash
imperium iniciar-sesion --url https://ejemplo.codice-progressio.online --usuario ana@empresa --dispositivo laptop
imperium estado --json
imperium          # TUI
```

La imagen `ghcr.io/opus-perpetuus/imperium-cli` se publica con la misma versión que el núcleo. En el servidor, el comando anfitrión `imperium` (instalado por `update-v13`) ejecuta `actualizar`, `doctor` y `logs` en el host, y el resto dentro del contenedor `cli`.
