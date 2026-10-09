import { DatabaseSync } from "node:sqlite";
import { OFFLINE_PENDING_SQL, OFFLINE_ROW_SQL } from "./schema";

export type NodeSqlite = {
	put_row(resource: string, id: string, body: Record<string, unknown>): void;
	get_row(resource: string, id: string): Record<string, unknown> | null;
	put_pending(server_id: string, client_id: string, seq: number, body: unknown): void;
	list_pending(server_id: string): unknown[];
	transaction<T>(run: () => T): T;
	close(): void;
};

export function open_node_sqlite(filename = ":memory:"): NodeSqlite {
	const db = new DatabaseSync(filename);
	db.exec(OFFLINE_ROW_SQL);
	db.exec(OFFLINE_PENDING_SQL);
	const put_row_stmt = db.prepare(
		`INSERT INTO offline_row (resource, id, body) VALUES (?, ?, ?)
		 ON CONFLICT(resource, id) DO UPDATE SET body = excluded.body`,
	);
	const get_row_stmt = db.prepare(
		`SELECT body FROM offline_row WHERE resource = ? AND id = ?`,
	);
	const put_pending_stmt = db.prepare(
		`INSERT INTO offline_pending (server_id, client_id, seq, body) VALUES (?, ?, ?, ?)
		 ON CONFLICT(server_id, client_id, seq) DO NOTHING`,
	);
	const list_pending_stmt = db.prepare(
		`SELECT body FROM offline_pending WHERE server_id = ? ORDER BY seq`,
	);
	return {
		put_row(resource, id, body) {
			put_row_stmt.run(resource, id, JSON.stringify(body));
		},
		get_row(resource, id) {
			const found = get_row_stmt.get(resource, id) as { body?: string } | null;
			if (!found?.body) return null;
			return JSON.parse(found.body) as Record<string, unknown>;
		},
		put_pending(server_id, client_id, seq, body) {
			put_pending_stmt.run(server_id, client_id, seq, JSON.stringify(body));
		},
		list_pending(server_id) {
			const rows = list_pending_stmt.all(server_id) as { body: string }[];
			return rows.map((row) => JSON.parse(row.body));
		},
		transaction(run) {
			db.exec("BEGIN");
			try {
				const value = run();
				db.exec("COMMIT");
				return value;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		close() {
			db.close();
		},
	};
}
