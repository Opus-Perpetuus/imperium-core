import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { OFFLINE_PENDING_SQL, OFFLINE_ROW_SQL } from "./schema";

const OPFS_VFS = "opfs-sahpool";
const BROWSER_BUILD = new URL(
	"../../../node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs",
	import.meta.url,
);

type WasmDb = {
	exec(sql: string | { sql: string; bind?: unknown[]; rowMode?: string; callback?: (row: Record<string, unknown>) => void }): void;
	close(): void;
};

type WasmApi = {
	oo1: { DB: new (filename: string) => WasmDb };
	installOpfsSAHPoolVfs(opts: { name: string }): Promise<unknown>;
};

export function wasm_vfs(has_opfs: boolean): "opfs-sahpool" | "memory" {
	return has_opfs ? OPFS_VFS : "memory";
}

export function browser_has_opfs(): boolean {
	return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

let loading: Promise<WasmApi> | null = null;

async function load_sqlite(): Promise<WasmApi> {
	loading ??= (async () => {
		const from_package = (await sqlite3InitModule()) as WasmApi;
		if (typeof from_package.installOpfsSAHPoolVfs === "function") return from_package;
		// El build de Node no incluye OPFS. La PWA usa el build de navegador, que sí.
		const mod = (await import(BROWSER_BUILD.href)) as { default: () => Promise<WasmApi> };
		return mod.default();
	})();
	return loading;
}

export async function sqlite_wasm_supports_opfs(): Promise<boolean> {
	const sqlite3 = await load_sqlite();
	return typeof sqlite3.installOpfsSAHPoolVfs === "function";
}

export type WasmSqlite = {
	vfs: string;
	put_row(resource: string, id: string, body: Record<string, unknown>): void;
	get_row(resource: string, id: string): Record<string, unknown> | null;
	list_rows(resource: string): Record<string, unknown>[];
	close(): void;
};

export async function open_sqlite_wasm(filename = ":memory:"): Promise<WasmSqlite> {
	const sqlite3 = await load_sqlite();
	const use_pool = browser_has_opfs() && filename !== ":memory:";
	const vfs = wasm_vfs(use_pool);
	if (use_pool) {
		await sqlite3.installOpfsSAHPoolVfs({ name: OPFS_VFS });
	}
	const db = use_pool
		? new sqlite3.oo1.DB(`file:${filename}?vfs=${OPFS_VFS}`)
		: new sqlite3.oo1.DB(filename === ":memory:" ? filename : `/${filename}.sqlite`);
	db.exec(OFFLINE_ROW_SQL);
	db.exec(OFFLINE_PENDING_SQL);
	return {
		vfs,
		put_row(resource, id, body) {
			db.exec({
				sql: `INSERT INTO offline_row (resource, id, body) VALUES (?, ?, ?)
				 ON CONFLICT(resource, id) DO UPDATE SET body = excluded.body`,
				bind: [resource, id, JSON.stringify(body)],
			});
		},
		get_row(resource, id) {
			let found: Record<string, unknown> | null = null;
			db.exec({
				sql: `SELECT body FROM offline_row WHERE resource = ? AND id = ?`,
				bind: [resource, id],
				rowMode: "object",
				callback: (row) => {
					const body = row.body;
					if (typeof body === "string") found = JSON.parse(body) as Record<string, unknown>;
				},
			});
			return found;
		},
		list_rows(resource: string) {
			const rows: Record<string, unknown>[] = [];
			db.exec({
				sql: `SELECT id, body FROM offline_row WHERE resource = ? ORDER BY id`,
				bind: [resource],
				rowMode: "object",
				callback: (row) => {
					const body = typeof row.body === "string" ? JSON.parse(row.body) as Record<string, unknown> : {};
					rows.push({ ...body, id: String(row.id) });
				},
			});
			return rows;
		},
		close() {
			db.close();
		},
	};
}
