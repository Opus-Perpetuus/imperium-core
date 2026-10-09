import { apply_mutation_batch } from "./apply";
import {
	type Authority,
	type MutationResult,
	type NamedMutation,
	create_authority,
} from "./types";

export type LocalSession = {
	server_id: string;
	client_id: string;
	pin_salt: string;
	pin_hash: string;
	unlocked: boolean;
	user: Record<string, unknown> | null;
	menu: unknown;
	corte_at: string | null;
	catalog_rows: { resource: string; id: string; fields: Record<string, unknown> }[];
	staging: { resource: string; id: string; fields: Record<string, unknown> }[] | null;
	pending: NamedMutation[];
	deferred: NamedMutation[];
	next_seq: number;
	migrated: string[];
	local: Authority;
};

export async function pin_digest(pin: string, salt: string): Promise<string> {
	const bytes = new TextEncoder().encode(`${salt}:${pin}`);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export function create_device(input: {
	server_id: string;
	client_id: string;
}): LocalSession {
	return {
		server_id: input.server_id,
		client_id: input.client_id,
		pin_salt: "",
		pin_hash: "",
		unlocked: false,
		user: null,
		menu: null,
		corte_at: null,
		catalog_rows: [],
		staging: null,
		pending: [],
		deferred: [],
		next_seq: 1,
		migrated: [],
		local: create_authority(),
	};
}

export async function prepare_local_session(
	device: LocalSession,
	input: {
		pin: string;
		user: Record<string, unknown>;
		menu: unknown;
		corte_at: string;
		rows: { resource: string; id: string; fields: Record<string, unknown> }[];
	},
): Promise<void> {
	const salt_bytes = crypto.getRandomValues(new Uint8Array(16));
	const salt = [...salt_bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	device.pin_salt = salt;
	device.pin_hash = await pin_digest(input.pin, salt);
	device.user = input.user;
	device.menu = input.menu;
	device.corte_at = input.corte_at;
	device.catalog_rows = input.rows.map((row) => ({ ...row }));
	device.unlocked = false;
}

export async function unlock_with_pin(
	device: LocalSession,
	pin: string,
): Promise<boolean> {
	if (!device.pin_hash || !device.user) return false;
	const digest = await pin_digest(pin, device.pin_salt);
	if (digest !== device.pin_hash) return false;
	device.unlocked = true;
	return true;
}

export function corte_stamp(corte_at: string): string {
	const date = new Date(corte_at);
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	return `al corte de las ${hh}:${mm}`;
}

export function read_local(
	device: LocalSession,
	query: { resource: string; q?: string },
): {
	rows: Record<string, unknown>[];
	stamp: string;
	corte_at: string;
} {
	if (!device.unlocked) throw new Error("Sesión local bloqueada");
	if (!device.corte_at) throw new Error("No hay corte local");
	const needle = (query.q ?? "").trim().toLowerCase();
	const from_catalog = device.catalog_rows.filter((row) => row.resource === query.resource);
	const from_local = [...device.local.rows.entries()]
		.filter(([key]) => key.startsWith(`${query.resource}\0`))
		.map(([, row]) => row);
	const merged = new Map<string, Record<string, unknown>>();
	for (const row of from_catalog) {
		merged.set(row.id, { ...row.fields, id: row.id, resource: row.resource });
	}
	for (const row of from_local) {
		merged.set(String(row.id), row);
	}
	const rows = [...merged.values()].filter((row) => {
		if (!needle) return true;
		return JSON.stringify(row).toLowerCase().includes(needle);
	});
	return {
		rows,
		stamp: corte_stamp(device.corte_at),
		corte_at: device.corte_at,
	};
}

export function begin_bootstrap(device: LocalSession): void {
	device.staging = [];
}

export function stage_bootstrap(
	device: LocalSession,
	rows: { resource: string; id: string; fields: Record<string, unknown> }[],
): void {
	if (!device.staging) throw new Error("No hay bootstrap abierto");
	device.staging.push(...rows);
}

export function abort_bootstrap(device: LocalSession): void {
	device.staging = null;
}

export function commit_bootstrap(device: LocalSession, corte_at: string): void {
	if (!device.staging) throw new Error("No hay bootstrap abierto");
	device.catalog_rows = device.staging;
	device.corte_at = corte_at;
	device.staging = null;
}

export function enqueue_mutation(
	device: LocalSession,
	input: Omit<NamedMutation, "server_id" | "client_id" | "seq" | "version"> & {
		version?: number;
		server_id?: string;
	},
): MutationResult {
	const mutation: NamedMutation = {
		server_id: input.server_id ?? device.server_id,
		client_id: device.client_id,
		seq: device.next_seq,
		name: input.name,
		version: input.version ?? 1,
		payload: input.payload,
	};
	device.next_seq += 1;
	const [result] = apply_mutation_batch(device.local, [mutation]);
	device.pending.push(mutation);
	return result!;
}

export function pending_for_server(
	device: LocalSession,
	server_id: string,
): NamedMutation[] {
	return device.pending.filter((mutation) => mutation.server_id === server_id);
}

export function switch_server(device: LocalSession, server_id: string): void {
	device.server_id = server_id;
}

export function logout(device: LocalSession): void {
	device.unlocked = false;
	device.user = null;
}

export function reset_version(device: LocalSession): void {
	device.catalog_rows = [];
	device.staging = null;
	device.unlocked = false;
}

export function sync_device(
	device: LocalSession,
	authority: Authority,
): MutationResult[] {
	const batch = pending_for_server(device, device.server_id);
	const results = apply_mutation_batch(authority, batch);
	const sent = new Set(batch.map((mutation) => mutation.seq));
	device.pending = device.pending.filter(
		(mutation) => mutation.server_id !== device.server_id || !sent.has(mutation.seq),
	);
	return results;
}

export function defer_mutation(
	device: LocalSession,
	mutation: NamedMutation,
): void {
	device.deferred.push(mutation);
}
