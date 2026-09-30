# Contadores (auto-increment) en v13


Núcleo: `modular/core/src/imperium/custom-pattern-render.ts` (asignación, segmentos
`own_count`) e `increment-normalize.ts` (acción "Estandarizar folios", normal / forzosa).
Invariantes aprendidos en producción — no romperlos:

- `ref_value` y `current_real_value` de `auto_increment_control` son **jsonb**. Bun.SQL codifica
  en JSON los parámetros de columnas jsonb y decodifica al leer: una fila creada por el store con
  `ref_value: 'OBR'` vuelve como `'OBR'`, pero las filas **migradas** de Mongo (pre-stringify +
  re-encode) vuelven **envueltas** (`'"OBR"'`), y algunas rutas viejas las doble-envolvieron. Todo
  lector compara con `unwrap_ref_value()` (desenvuelve a cualquier profundidad); nunca con
  `String(row.ref_value)`.
- Un segmento se identifica por `_unique_string_reference`
  (`collection::model::field::index::JSON.stringify(ref)`, único en Postgres).
  `find_increment_segment` busca **primero por esa clave**, luego por `ref_value` plano/envuelto y
  al final barre por `model_name` casando `increment_field ?? campo` en memoria (filas legacy con
  la columna en NULL). `find_or_create_increment_segment` **repara** la fila reutilizada
  (`ref_value`/`segment` planos) y, si el insert choca con el unique, relee por clave: crear un
  segmento nunca debe lanzar "Ya existe un registro con el campo _unique_string_reference".
- La normalización **nunca aborta la corrida**: cada documento, tracker o índice que falle queda en
  `summary.errors` / `failed_documents` / `failed_indexes` (los ilegibles en `unresolved_documents`),
  y el resto sigue. En modo forzoso los folios se reescriben en orden sin pisar un valor que otro
  documento aún ocupa (campos únicos como `name` de tickets o `codigo` de SKU); un intercambio A↔B se
  rompe con un valor temporal. Un documento que no se pudo renumerar conserva su folio y su secuencia
  actúa como **piso** del tracker (la siguiente alta no lo repite). Los trackers duplicados del mismo
  segmento quedan en el mismo conteo y los huérfanos en 0.
- Un `[custom]` sin valor (departamento sin condición, condición borrada) **nunca se reescribe**: el
  documento queda intacto y se reporta; renderizarlo daría `-001` y contarlo pisaría el contador
  global. La identidad de un contador es `(model_name, increment_field)`: solo hay una global activa
  por campo (`prepare_increment_create` lo exige aunque cambie `index_name`), `find_increment_control`
  solo devuelve filas globales (un segmento nunca es configuración) e `is_global_ref` desenvuelve
  (`'""'` migrado = global).
- Reproducir contra Postgres real: `new ImperiumStore(new Bun.SQL(url), load_catalog_path())`
  + `ensure_unique_indexes()`, tablas GENERAL + columnas del catálogo (`pg: json` → JSONB) e
  inserts crudos con `$n::jsonb` pasando el valor JS tal cual (Bun lo codifica). Los specs
  `increment-normalize.spec.ts` / `custom-pattern-render.spec.ts` (memory_store) cubren plano,
  envuelto, doble envuelto, ref perdido, `campo` legacy, folio único y fallos por documento/índice.
