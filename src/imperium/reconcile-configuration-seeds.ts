/** Copia de backend/.../reconcile-configuration-seeds.ts. El Dockerfile de core no incluye backend/. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ConfigurationSeedDoc = {
    _ref: string;
    module_id?: unknown;
    value?: unknown;
    [key: string]: unknown;
};

export type ExistingConfiguration = {
    _ref?: unknown;
    module_id?: unknown;
    value?: unknown;
    [key: string]: unknown;
};

export type ModuleIdPatch = { _ref: string; module_id: string };

export type ReconcileConfigurationSeedsResult = {
    inserts: ConfigurationSeedDoc[];
    module_id_patches: ModuleIdPatch[];
};

const PLACEHOLDER_MODULE_IDS = new Set(["", "na", "n/a", "null", "undefined"]);

/**
 * True when `module_id` is absent, blank, or the seed sentinel `NA`.
 */
export function is_missing_module_id(value: unknown): boolean {
    if (value == null) return true;
    const normalized = String(value).trim().toLowerCase();
    return PLACEHOLDER_MODULE_IDS.has(normalized);
}

/**
 * Maps a seed `module_id` (`NA`, plugin slug, or already-stored id) to the
 * `module-management` `_id` the form expects.
 */
export function make_module_id_resolver(
    modules: Array<{
        _id?: unknown;
        id?: unknown;
        module_name?: unknown;
        name?: unknown;
    }>,
): (seed_module_id: unknown) => string | null {
    const by_id = new Map<string, string>();
    const by_name = new Map<string, string>();
    for (const row of modules) {
        const id = String(row._id ?? row.id ?? "").trim();
        if (!id) continue;
        by_id.set(id, id);
        const module_name = String(row.module_name ?? "")
            .trim()
            .toLowerCase();
        if (module_name) by_name.set(module_name, id);
        const name = String(row.name ?? "").trim().toLowerCase();
        if (name) by_name.set(name, id);
    }
    const configuration_id = by_name.get("configuration") ?? null;
    return (seed_module_id: unknown) => {
        if (is_missing_module_id(seed_module_id)) return configuration_id;
        const token = String(seed_module_id).trim();
        if (by_id.has(token)) return by_id.get(token) ?? null;
        return by_name.get(token.toLowerCase()) ?? null;
    };
}

/**
 * Decide inserts and `module_id` patches. Never rewrites an existing `value`.
 */
export function reconcile_configuration_seeds(
    seeds: ConfigurationSeedDoc[],
    existing: ExistingConfiguration[],
    resolve_module_id: (seed_module_id: unknown) => string | null,
): ReconcileConfigurationSeedsResult {
    const by_ref = new Map<string, ExistingConfiguration>();
    for (const row of existing) {
        const ref = typeof row._ref === "string" ? row._ref.trim() : "";
        if (ref) by_ref.set(ref, row);
    }
    const inserts: ConfigurationSeedDoc[] = [];
    const module_id_patches: ModuleIdPatch[] = [];
    const seen = new Set<string>();
    for (const seed of seeds) {
        const ref = typeof seed._ref === "string" ? seed._ref.trim() : "";
        if (!ref || seen.has(ref)) continue;
        seen.add(ref);
        const resolved = resolve_module_id(seed.module_id);
        const current = by_ref.get(ref);
        if (!current) {
            inserts.push({
                ...seed,
                _ref: ref,
                module_id: resolved ?? seed.module_id,
            });
            continue;
        }
        if (resolved && is_missing_module_id(current.module_id)) {
            module_id_patches.push({ _ref: ref, module_id: resolved });
        }
    }
    return { inserts, module_id_patches };
}

function read_balanced_args(src: string, open_index: number) {
    let depth = 0;
    let in_str: string | null = null;
    let escape = false;
    for (let i = open_index; i < src.length; i++) {
        const c = src[i]!;
        if (in_str) {
            if (escape) {
                escape = false;
                continue;
            }
            if (c === "\\") {
                escape = true;
                continue;
            }
            if (c === in_str) in_str = null;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") {
            in_str = c;
            continue;
        }
        if (c === "(") depth += 1;
        else if (c === ")") {
            depth -= 1;
            if (depth === 0) return src.slice(open_index + 1, i);
        }
    }
    return "";
}

function split_top_args(args: string) {
    const parts: string[] = [];
    let depth_paren = 0;
    let depth_brace = 0;
    let depth_brack = 0;
    let in_str: string | null = null;
    let escape = false;
    let start = 0;
    for (let i = 0; i < args.length; i++) {
        const c = args[i]!;
        if (in_str) {
            if (escape) {
                escape = false;
                continue;
            }
            if (c === "\\") {
                escape = true;
                continue;
            }
            if (c === in_str) in_str = null;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") {
            in_str = c;
            continue;
        }
        if (c === "(") depth_paren += 1;
        else if (c === ")") depth_paren -= 1;
        else if (c === "{") depth_brace += 1;
        else if (c === "}") depth_brace -= 1;
        else if (c === "[") depth_brack += 1;
        else if (c === "]") depth_brack -= 1;
        else if (
            c === "," &&
            depth_paren === 0 &&
            depth_brace === 0 &&
            depth_brack === 0
        ) {
            parts.push(args.slice(start, i).trim());
            start = i + 1;
        }
    }
    const last = args.slice(start).trim();
    if (last) parts.push(last);
    return parts;
}

function strip_ts_comments(src: string) {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function eval_seed_object(
    expr: string,
    bindings: Record<string, unknown>,
): Record<string, unknown> | null {
    let text = expr.trim().replace(/,\s*$/, "");
    text = text.replace(
        /([A-Za-z0-9_]+)Model\.modelName(?:\s+as\s+string)?/g,
        (_, name: string) => JSON.stringify(name.replace(/Model$/, "")),
    );
    const keys = Object.keys(bindings);
    const values = Object.values(bindings);
    try {
        const doc = new Function(
            ...keys,
            `"use strict"; return (${text});`,
        )(...values);
        if (doc && typeof doc === "object" && !Array.isArray(doc)) {
            return doc as Record<string, unknown>;
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * Configuration parameter `.record({...})` blocks from one `module.data.ts`.
 */
export function extract_configuration_parameter_seeds(
    src: string,
    bindings: Record<string, unknown> = {},
): ConfigurationSeedDoc[] {
    const stripped = strip_ts_comments(src);
    const records: ConfigurationSeedDoc[] = [];
    let model = "";
    let i = 0;
    while (i < stripped.length) {
        const rest = stripped.slice(i);
        const add = rest.match(
            /^add_model(?:<[^>]*>)?\(\s*([A-Za-z0-9_]+)\.modelName/,
        );
        if (add) {
            model = add[1]!.replace(/Model$/, "");
            i += add[0].length;
            continue;
        }
        if (rest.startsWith(".record(") || rest.startsWith("record(")) {
            const paren = stripped.indexOf("(", i);
            const args = read_balanced_args(stripped, paren);
            const first = split_top_args(args)[0] ?? "{}";
            const doc = eval_seed_object(first, bindings);
            if (
                model === "Configuration" &&
                doc &&
                typeof doc._ref === "string" &&
                doc._ref.trim()
            ) {
                records.push({ ...doc, _ref: doc._ref.trim() });
            }
            i = paren + args.length + 2;
            continue;
        }
        i += 1;
    }
    return records;
}

function read_balanced_braces(src: string, open_index: number): string {
    let depth = 0;
    let in_str: string | null = null;
    let escape = false;
    for (let i = open_index; i < src.length; i++) {
        const c = src[i]!;
        if (in_str) {
            if (escape) {
                escape = false;
                continue;
            }
            if (c === "\\") {
                escape = true;
                continue;
            }
            if (c === in_str) in_str = null;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") {
            in_str = c;
            continue;
        }
        if (c === "{") depth += 1;
        else if (c === "}") {
            depth -= 1;
            if (depth === 0) return src.slice(open_index, i + 1);
        }
    }
    return "";
}

function collect_local_bindings(src: string): Record<string, unknown> {
    const stripped = strip_ts_comments(src);
    const bindings: Record<string, unknown> = {};
    const re = /(?:export\s+)?const ([A-Z0-9_]+)\s*=\s*/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(stripped))) {
        const name = match[1]!;
        let i = re.lastIndex;
        while (i < stripped.length && /\s/.test(stripped[i]!)) i += 1;
        const ch = stripped[i];
        if (ch === '"' || ch === "'") {
            const end = stripped.indexOf(ch, i + 1);
            if (end < 0) continue;
            bindings[name] = stripped.slice(i + 1, end);
            continue;
        }
        if (ch === "{") {
            const body = read_balanced_braces(stripped, i);
            if (!body) continue;
            try {
                bindings[name] = new Function(`return (${body});`)();
            } catch {
                /* skip unparsable maps */
            }
        }
    }
    return bindings;
}

function resolve_import_path(
    spec: string,
    from_file: string,
    backend_src_root: string,
): string {
    const path_spec = spec.replace(/\.js$/, "");
    if (path_spec.startsWith("#components/")) {
        return `${join(backend_src_root, "components", path_spec.slice("#components/".length))}.ts`;
    }
    if (path_spec.startsWith("#plugins/")) {
        return `${join(backend_src_root, "plugins", path_spec.slice("#plugins/".length))}.ts`;
    }
    if (path_spec.startsWith("#models/")) {
        return `${join(backend_src_root, "models", path_spec.slice("#models/".length))}.ts`;
    }
    if (path_spec.startsWith(".")) {
        return path_spec.endsWith(".ts")
            ? join(dirname(from_file), path_spec)
            : `${join(dirname(from_file), path_spec)}.ts`;
    }
    return "";
}

function imported_binding_names(clause: string): string[] {
    return clause
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith("type "))
        .map((part) => part.split(/\s+as\s+/)[0]!.trim())
        .filter((name) => /^[A-Z0-9_]+$/.test(name));
}

function collect_file_bindings(
    file: string,
    backend_src_root: string,
    cache = new Map<string, Record<string, unknown>>(),
): Record<string, unknown> {
    if (!existsSync(file)) return {};
    const cached = cache.get(file);
    if (cached) return cached;
    const src = readFileSync(file, "utf8");
    const bindings = collect_local_bindings(src);
    cache.set(file, bindings);
    for (const match of src.matchAll(
        /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g,
    )) {
        if (/^import\s+type\s+\{/.test(match[0]!)) continue;
        const names = imported_binding_names(match[1]!);
        if (!names.length) continue;
        const imported = resolve_import_path(
            match[2]!,
            file,
            backend_src_root,
        );
        if (!imported || !existsSync(imported)) continue;
        const nested = collect_file_bindings(
            imported,
            backend_src_root,
            cache,
        );
        for (const name of names) {
            if (name in nested) bindings[name] = nested[name];
        }
    }
    return bindings;
}

function list_module_data_files(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name === "api") continue;
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name === "module.data.ts") out.push(path);
        }
    };
    walk(join(root, "components"));
    walk(join(root, "plugins"));
    return out;
}

/**
 * Every Configuration seed across `backend/src` module.data files.
 */
export function load_configuration_parameter_seeds(
    backend_src_root: string,
): ConfigurationSeedDoc[] {
    const all: ConfigurationSeedDoc[] = [];
    const seen = new Set<string>();
    for (const file of list_module_data_files(backend_src_root)) {
        const src = readFileSync(file, "utf8");
        const bindings = collect_file_bindings(file, backend_src_root);
        for (const doc of extract_configuration_parameter_seeds(src, bindings)) {
            if (seen.has(doc._ref)) continue;
            seen.add(doc._ref);
            all.push(doc);
        }
    }
    return all;
}
