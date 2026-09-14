# @opus-perpetuus/imperium-core-kit

Contratos TypeScript y runtime de **apps Imperium** (descriptores UI, manifest,
envelopes, `define_subject` / `serve_subject`).

Paquete: `@opus-perpetuus/imperium-core-kit`. Una app = un repo
`imperium-subject-<slug>` + imagen GHCR. La app no abre Postgres; el núcleo
aplica el DDL.

La carpeta `src/kirlet/` es el runtime interno. El autorío Imperium usa los
alias de `src/index.ts`: `define_subject`, `serve_subject`,
`assert_subject_conformance`, `SubjectTableDecl`.

## Superficie (Node)

```ts
import {
  define_subject,
  define_module,
  define_crud,
  define_routes,
  serve_subject,
  create_subject_test_context,
  assert_subject_conformance,
} from "@opus-perpetuus/imperium-core-kit";

export const SUBJECT = define_subject({
  id: "SUBJECT-demo",
  name: "Demo",
  compat: { nox: ">=0.5.0", kit: "^0.5.0" },
  modules: [
    define_module({
      resource: "notes",
      labels: { singular: "Note", plural: "Notes" },
      routes: define_crud({
        resource: "notes",
        fields: { title: { type: "string", required: true, search: true } },
      }),
      tables: [/* SubjectTableDecl[] */],
    }),
  ],
});

serve_subject(SUBJECT);
```

Angular importa `@opus-perpetuus/imperium-core-kit/browser` (sin `node:crypto`).

## Build / test

```bash
bun run build
bun test src
```
