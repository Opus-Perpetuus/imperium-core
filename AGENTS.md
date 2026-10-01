# AGENTS.md

Reglas para cualquier agente (Claude, Cursor, Copilot, Codex, Grok, Gemini…) y para
personas. `CLAUDE.md` es un enlace a este archivo.

## Ramas: una por desarrollador (estricto)

> Trabaja y commitea en la rama que ya está checkout. **No crees ninguna rama.**

- Nada de `feature/*`, `fix/*`, `topic-*` por tarea, `cursor/*`, `claude/*`, `grok/*`, ni
  una rama por ticket, por feature o por agente.
- Prohibido `git checkout -b`, `git switch -c`, `git push origin <rama-nueva>` y abrir un
  worktree por iniciativa propia (un worktree también es una rama).
- Rama de trabajo: la de cada desarrollador si el repo las tiene (`dev-yael`, `dev-rafa`…);
  si no, `main`.
- Si la plataforma te fuerza una rama propia (`cursor/…`, `claude/…`, `grok/…`): antes de
  cerrar, mergéala a la rama de trabajo y bórrala en local (`git branch -d`) y en remoto
  (`git push origin --delete`). Obligatorio aunque nadie lo pida; si no puedes borrar el
  remoto, nombra la rama en tu resumen final.
- Única excepción: el usuario pide aislar trabajo o correr agentes en paralelo. La rama
  temporal es local, nunca se empuja, y se mergea y se borra en la misma sesión.

Regla completa: [`docs/REGLA_RAMA_UNICA.md`](https://github.com/codice-progressio/imperium-SIC-ayuntamiento-zapotlanejo/blob/version-13/docs/REGLA_RAMA_UNICA.md)
del monorepo `codice-progressio/imperium-SIC-ayuntamiento-zapotlanejo`.
