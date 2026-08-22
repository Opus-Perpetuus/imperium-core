# @opus-perpetuus/kirel-nox-kit

Shared TypeScript contracts and **kirlet v2 runtime** for **Kirel NOX** (UI descriptors, manifest, envelopes, `define_kirlet` / `serve_kirlet`).

**Version:** 0.5.0 — see [`docs/contracts/kirlet-development.md`](../../docs/contracts/kirlet-development.md) for the authoring standard.

## npm naming (Opus Perpetuus)

| Conceptual path | npm package name |
|-----------------|------------------|
| `@opus-perpetuus/kirel-nox/kit` | `@opus-perpetuus/kirel-nox-kit` |

## Install

```bash
npm install @opus-perpetuus/kirel-nox-kit
# or file: dependency from a sibling kirlet:
# "@opus-perpetuus/kirel-nox-kit": "file:../kirel-nox/libs/kit"
```

## Kirlet v2 surface (Node)

```ts
import {
  define_kirlet,
  define_module,
  define_crud,
  define_routes,
  serve_kirlet,
  create_kirlet_test_context,
  assert_kirlet_conformance,
  MemoryNoxServices,
  MemoryKirletDataClient,
} from "@opus-perpetuus/kirel-nox-kit";

export const KIRLET = define_kirlet({
  id: "KIRLET-demo",
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
      tables: [/* KirletTableDecl[] */],
    }),
  ],
});

// production
// serve_kirlet(KIRLET);

// tests
const ctx = create_kirlet_test_context(KIRLET);
await ctx.fetch(new Request("http://t/health"));
```

### Modules

| Export | Purpose |
|--------|---------|
| `compile_route` / `match_route` / `match_route_table` | Typed route matcher (`method_mismatch` vs `miss`) |
| `json_response` / `error_response` / `KirletHttpError` | HTTP helpers |
| `resolve_identity` / `require_access` | Runtime auth |
| `resolve_kirlet_config` | Env config + data mode |
| `FsKirletFileStore` / `MemoryKirletFileStore` | Blob store |
| `NoxServices` + Memory/HTTP clients | history, counters, params, notify, logs |
| `define_routes` / `define_module` / `define_crud` | Authorship |
| `define_kirlet` | Manifest + schema derivation (`resources` map) |
| `serve_kirlet` | Full process shell |
| `assert_kirlet_conformance` | CI structure checks |

Browser/Angular should import `@opus-perpetuus/kirel-nox-kit/browser` (no Node crypto).

## Build / test

```bash
bun run build
bun test src
```

## Publish (maintainers)

```bash
bun run build
npm publish --access public
```
