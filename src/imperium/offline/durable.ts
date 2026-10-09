import { DatabaseSync } from "node:sqlite";
import { guard_store_insert } from "../store.ts";
import { apply_mutation_batch } from "./apply";
import { create_authority, row_key } from "./types";
import type { MutationResult, NamedMutation } from "./types";

export type SyncTx = {
	get_row(resource: string, id: string): Promise<Record<string, unknown> | null>;
	put_row(resource: string, id: string, row: Record<string, unknown>): Promise<void>;
	get_ledger(server_id: string, client_id: string, seq: number): Promise<MutationResult | null>;
	put_ledger(
		server_id: string,
		client_id: string,
		seq: number,
		result: MutationResult,
	): Promise<void>;
};

export type SyncStore = {
	begin<T>(run: (tx: SyncTx) => Promise<T>): Promise<T>;
};

export type ResourceStore = {
	has(resource: string): boolean;
	find_id(resource: string, id: string): Promise<Record<string, unknown> | null>;
	insert(resource: string, doc: Record<string, unknown>): Promise<Record<string, unknown>>;
	update(
		resource: string,
		id: string,
		patch: Record<string, unknown>,
	): Promise<Record<string, unknown> | null>;
};

export function mirror_resource_store(inner: SyncStore, resources: ResourceStore): SyncStore {
	return {
		async begin(run) {
			const staged: { resource: string; id: string; row: Record<string, unknown> }[] = [];
			return inner.begin(async (tx) => {
				const value = await run({
					async get_row(resource, id) {
						const staged_row = [...staged]
							.reverse()
							.find((item) => item.resource === resource && item.id === id);
						if (staged_row) return staged_row.row;
						if (resources.has(resource)) {
							const live = await resources.find_id(resource, id);
							if (live) return live;
						}
						return tx.get_row(resource, id);
					},
					async put_row(resource, id, row) {
						await tx.put_row(resource, id, row);
						if (resources.has(resource)) staged.push({ resource, id, row });
					},
					get_ledger: (server_id, client_id, seq) => tx.get_ledger(server_id, client_id, seq),
					put_ledger: (server_id, client_id, seq, result) =>
						tx.put_ledger(server_id, client_id, seq, result),
				});
				for (const item of staged) {
					const existing = await resources.find_id(item.resource, item.id);
					if (!existing) {
						await resources.insert(item.resource, { ...item.row, _id: item.id });
					} else {
						await resources.update(item.resource, item.id, item.row);
					}
				}
				return value;
			});
		},
	};
}

const ROW_SQL = `CREATE TABLE IF NOT EXISTS imperium_sync_row (
  resource TEXT NOT NULL,
  id TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (resource, id)
)`;

const LEDGER_SQL = `CREATE TABLE IF NOT EXISTS imperium_sync_ledger (
  server_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (server_id, client_id, seq)
)`;

type SqlRunner = {
	unsafe(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
};

export type SqlDatabase = SqlRunner & {
	begin<T>(run: (tx: SqlRunner) => Promise<T>): Promise<T>;
};

function ph(index: number, style: "sqlite" | "postgres"): string {
	return style === "postgres" ? `$${index}` : "?";
}

function adapter(tx: SqlRunner, style: "sqlite" | "postgres"): SyncTx {
	return {
		async get_row(resource, id) {
			const rows = await tx.unsafe(
				`SELECT body FROM imperium_sync_row WHERE resource = ${ph(1, style)} AND id = ${ph(2, style)}`,
				[resource, id],
			);
			const body = rows[0]?.body;
			if (typeof body !== "string" || !body) return null;
			return JSON.parse(body) as Record<string, unknown>;
		},
		async put_row(resource, id, row) {
			await tx.unsafe(
				`INSERT INTO imperium_sync_row (resource, id, body) VALUES (${ph(1, style)}, ${ph(2, style)}, ${ph(3, style)})
				 ON CONFLICT(resource, id) DO UPDATE SET body = excluded.body`,
				[resource, id, JSON.stringify(row)],
			);
		},
		async get_ledger(server_id, client_id, seq) {
			const rows = await tx.unsafe(
				`SELECT result FROM imperium_sync_ledger WHERE server_id = ${ph(1, style)} AND client_id = ${ph(2, style)} AND seq = ${ph(3, style)}`,
				[server_id, client_id, seq],
			);
			const result = rows[0]?.result;
			if (typeof result !== "string" || !result) return null;
			return JSON.parse(result) as MutationResult;
		},
		async put_ledger(server_id, client_id, seq, result) {
			await tx.unsafe(
				`INSERT INTO imperium_sync_ledger (server_id, client_id, seq, result) VALUES (${ph(1, style)}, ${ph(2, style)}, ${ph(3, style)}, ${ph(4, style)})
				 ON CONFLICT(server_id, client_id, seq) DO NOTHING`,
				[server_id, client_id, seq, JSON.stringify(result)],
			);
		},
	};
}

export function sql_sync_store(db: SqlDatabase, style: "sqlite" | "postgres"): SyncStore {
	let ready = false;
	return {
		async begin(run) {
			if (!ready) {
				await db.unsafe(ROW_SQL);
				await db.unsafe(LEDGER_SQL);
				ready = true;
			}
			return db.begin((tx) => run(adapter(tx, style)));
		},
	};
}

function sqlite_database(db: DatabaseSync): SqlDatabase {
	const runner = (target: DatabaseSync): SqlRunner => ({
		async unsafe(sql, params = []) {
			const statement = target.prepare(sql);
			if (/^\s*select/i.test(sql)) {
				return statement.all(...params) as Record<string, unknown>[];
			}
			statement.run(...params);
			return [];
		},
	});
	return {
		...runner(db),
		async begin(run) {
			db.exec("BEGIN");
			try {
				const value = await run(runner(db));
				db.exec("COMMIT");
				return value;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	};
}

export function sqlite_sync_store(filename = ":memory:"): SyncStore & { close(): void } {
	const db = new DatabaseSync(filename);
	const store = sql_sync_store(sqlite_database(db), "sqlite");
	return { ...store, close: () => db.close() };
}

const RESOURCE_SQL = `CREATE TABLE IF NOT EXISTS imperium_resource (
  resource TEXT NOT NULL,
  id TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (resource, id)
)`;

export function sqlite_imperium_sync(filename = ":memory:"): SyncStore & {
	close(): void;
	find_id(resource: string, id: string): Promise<Record<string, unknown> | null>;
	inserted(): number;
} {
	const db = new DatabaseSync(filename);
	db.exec(RESOURCE_SQL);
	let inserts = 0;
	const resources: ResourceStore = {
		has: () => true,
		async find_id(resource, id) {
			const row = db
				.prepare(`SELECT body FROM imperium_resource WHERE resource = ? AND id = ?`)
				.get(resource, id) as { body?: string } | null;
			if (!row?.body) return null;
			return JSON.parse(row.body) as Record<string, unknown>;
		},
		async insert(resource, doc) {
			const id = String(doc._id ?? doc.id);
			const row = { ...doc, id, _id: id };
			guard_store_insert(resource, row);
			inserts += 1;
			db.prepare(
				`INSERT INTO imperium_resource (resource, id, body) VALUES (?, ?, ?)`,
			).run(resource, id, JSON.stringify(row));
			return row;
		},
		async update(resource, id, patch) {
			const current = (await resources.find_id(resource, id)) ?? {};
			const next = { ...current, ...patch, id, _id: id };
			guard_store_insert(resource, next);
			db.prepare(
				`INSERT INTO imperium_resource (resource, id, body) VALUES (?, ?, ?)
				 ON CONFLICT(resource, id) DO UPDATE SET body = excluded.body`,
			).run(resource, id, JSON.stringify(next));
			return next;
		},
	};
	const sync = mirror_resource_store(sql_sync_store(sqlite_database(db), "sqlite"), resources);
	return {
		begin: (run) => sync.begin(run),
		close: () => db.close(),
		find_id: (resource, id) => resources.find_id(resource, id),
		inserted: () => inserts,
	};
}

export function imperium_sync_store(sql: SqlDatabase, resources: ResourceStore): SyncStore {
	return mirror_resource_store(postgres_sync_store(sql), resources);
}

export function postgres_sync_store(sql: SqlDatabase): SyncStore {
	return sql_sync_store(sql, "postgres");
}

const TERMINAL = new Set(["applied", "adjusted", "rejected", "conflict"]);

export function confirmed_seqs(
	results: { status?: string }[] | null | undefined,
	mutations: { seq: number }[],
): number[] {
	if (!Array.isArray(results)) return [];
	const seqs: number[] = [];
	for (let index = 0; index < mutations.length; index += 1) {
		const status = results[index]?.status;
		if (status && TERMINAL.has(status)) seqs.push(mutations[index]!.seq);
	}
	return seqs;
}

export async function replay_durable(
	store: SyncStore,
	mutations: NamedMutation[],
): Promise<MutationResult[]> {
	return store.begin(async (tx) => {
		const authority = create_authority();
		const results: MutationResult[] = [];
		for (const mutation of mutations) {
			const prior = await tx.get_ledger(mutation.server_id, mutation.client_id, mutation.seq);
			if (prior) {
				results.push(prior);
				continue;
			}
			const resource = String(mutation.payload.resource ?? "").trim();
			const id = String(mutation.payload.id ?? "").trim();
			if (resource && id) {
				const existing = await tx.get_row(resource, id);
				if (existing) authority.rows.set(row_key(resource, id), existing);
			}
			const batch = apply_mutation_batch(authority, [mutation]);
			const result = batch[0] ?? { status: "rejected" as const, reason: "Sin resultado", row: null };
			if (result.row && resource && id && result.status !== "rejected") {
				await tx.put_row(resource, id, result.row);
			}
			await tx.put_ledger(mutation.server_id, mutation.client_id, mutation.seq, result);
			results.push(result);
		}
		return results;
	});
}
