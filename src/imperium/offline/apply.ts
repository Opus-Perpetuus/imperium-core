import { cfdi_queue_state } from "./cfdi";
import { device_folio } from "./folio";
import { is_critical_field } from "./merge";
import {
	type Authority,
	type MutationResult,
	type NamedMutation,
	clone_authority,
	create_authority,
	ledger_key,
	restore_authority,
	row_key,
} from "./types";

export { create_authority };

const FAIL_NAME = "test.fail";

export function apply_mutation_batch(
	authority: Authority,
	batch: NamedMutation[],
): MutationResult[] {
	const snapshot = clone_authority(authority);
	try {
		const results: MutationResult[] = [];
		for (const mutation of batch) {
			results.push(apply_one(authority, mutation));
		}
		return results;
	} catch (error) {
		restore_authority(authority, snapshot);
		throw error;
	}
}

export function list_rows(
	authority: Authority,
	resource: string,
): Record<string, unknown>[] {
	const rows: Record<string, unknown>[] = [];
	for (const [key, row] of authority.rows) {
		if (key.startsWith(`${resource}\0`)) rows.push(structuredClone(row));
	}
	rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
	return rows;
}

function apply_one(authority: Authority, mutation: NamedMutation): MutationResult {
	const key = ledger_key(mutation);
	const prior = authority.ledger.get(key);
	if (prior) return structuredClone(prior);
	if (mutation.name === FAIL_NAME) {
		throw new Error("Corte a mitad del lote");
	}
	const result = execute(authority, mutation);
	authority.ledger.set(key, structuredClone(result));
	return result;
}

function execute(authority: Authority, mutation: NamedMutation): MutationResult {
	switch (mutation.name) {
		case "record.create":
			return create_record(authority, mutation.payload);
		case "record.edit":
			return edit_record(authority, mutation.payload);
		case "stock.sell":
			return sell_stock(authority, mutation.payload);
		case "folio.issue":
			return issue_folio(authority, mutation.payload);
		case "cfdi.enqueue":
			return enqueue_cfdi(authority, mutation.payload);
		case "cfdi.stamp":
			return stamp_cfdi(authority, mutation.payload);
		case "pos.ticket":
			return provisional_ticket(authority, mutation.payload);
		default:
			return apply_named_action(authority, mutation);
	}
}

function apply_named_action(authority: Authority, mutation: NamedMutation): MutationResult {
	const resource = text(mutation.payload.resource);
	const id = text(mutation.payload.id);
	const fields = mutation.payload.fields;
	const patch = mutation.payload.patch;
	if (mutation.name === "edit" || (patch && typeof patch === "object")) {
		if (!resource || !id) {
			return { status: "rejected", reason: "Falta recurso o id", row: null };
		}
		const edit_patch =
			patch && typeof patch === "object"
				? { ...(patch as Record<string, unknown>), accion: mutation.name }
				: { accion: mutation.name };
		return edit_record(authority, {
			resource,
			id,
			base: mutation.payload.base,
			patch: edit_patch,
		});
	}
	if (!resource || !id || !fields || typeof fields !== "object") {
		return {
			status: "rejected",
			reason: `Mutación desconocida: ${mutation.name}`,
			row: null,
		};
	}
	return create_record(authority, {
		resource,
		id,
		fields: { ...(fields as Record<string, unknown>), accion: mutation.name },
	});
}

function text(value: unknown): string {
	return String(value ?? "").trim();
}

function create_record(
	authority: Authority,
	payload: Record<string, unknown>,
): MutationResult {
	const resource = text(payload.resource);
	const id = text(payload.id);
	if (!resource || !id) {
		return { status: "rejected", reason: "Falta recurso o id", row: null };
	}
	const key = row_key(resource, id);
	const existing = authority.rows.get(key);
	if (existing) return { status: "applied", row: structuredClone(existing) };
	const fields =
		payload.fields && typeof payload.fields === "object"
			? (payload.fields as Record<string, unknown>)
			: {};
	const row = { ...fields, resource, id };
	authority.rows.set(key, row);
	return { status: "applied", row: structuredClone(row) };
}

function edit_record(
	authority: Authority,
	payload: Record<string, unknown>,
): MutationResult {
	const resource = text(payload.resource);
	const id = text(payload.id);
	const key = row_key(resource, id);
	const current = authority.rows.get(key);
	if (!current) {
		return { status: "rejected", reason: "El registro no existe", row: null };
	}
	const base =
		payload.base && typeof payload.base === "object"
			? (payload.base as Record<string, unknown>)
			: {};
	const patch =
		payload.patch && typeof payload.patch === "object"
			? (payload.patch as Record<string, unknown>)
			: {};
	const review_fields: string[] = [];
	const next = { ...current };
	for (const [field, value] of Object.entries(patch)) {
		const base_value = base[field] ?? current[field];
		const current_value = current[field];
		const others_touched = !Object.is(current_value, base_value);
		if (others_touched && !Object.is(current_value, value)) {
			if (is_critical_field(field)) review_fields.push(field);
			else review_fields.push(field);
			continue;
		}
		next[field] = value;
	}
	if (review_fields.length > 0) {
		const review_id = `review-${resource}-${id}-${review_fields.join("-")}`;
		authority.reviews.push({
			id: review_id,
			field: review_fields.join(","),
			reason: "Edición simultánea",
		});
		return {
			status: "conflict",
			reason: `Campos en revisión: ${review_fields.join(", ")}`,
			review_id,
			row: structuredClone(current),
		};
	}
	authority.rows.set(key, next);
	return { status: "applied", row: structuredClone(next) };
}

function sell_stock(
	authority: Authority,
	payload: Record<string, unknown>,
): MutationResult {
	const sku = text(payload.sku);
	const sale_id = text(payload.sale_id);
	const qty = Number(payload.qty ?? 0);
	if (!sku || !sale_id || !Number.isFinite(qty) || qty <= 0) {
		return { status: "rejected", reason: "Venta de stock incompleta", row: null };
	}
	let item = authority.stock.get(sku);
	if (!item) {
		const seed = Number(payload.on_hand ?? 0);
		item = { on_hand: Number.isFinite(seed) ? seed : 0, sales: [] };
		authority.stock.set(sku, item);
	}
	if (item.sales.includes(sale_id)) {
		return {
			status: "applied",
			row: { sku, sale_id, on_hand: item.on_hand },
		};
	}
	item.on_hand -= qty;
	item.sales.push(sale_id);
	const row = { sku, sale_id, qty, on_hand: item.on_hand };
	if (item.on_hand < 0) {
		authority.alerts.push({
			sku,
			sale_id,
			compensated: Math.abs(item.on_hand),
		});
		return {
			status: "adjusted",
			reason: "Stock escaso: la venta se conserva y se compensa",
			row,
		};
	}
	return { status: "applied", row };
}

function issue_folio(
	authority: Authority,
	payload: Record<string, unknown>,
): MutationResult {
	const device_id = text(payload.device_id);
	const local_n = Number(payload.local_n ?? 0);
	let folio: string;
	try {
		folio = device_folio(device_id, local_n);
	} catch (error) {
		return {
			status: "rejected",
			reason: error instanceof Error ? error.message : "Folio inválido",
			row: null,
		};
	}
	if (authority.folios.has(folio)) {
		return {
			status: "rejected",
			reason: `El folio ${folio} ya existe`,
			row: null,
		};
	}
	authority.folios.add(folio);
	const row = { folio, device_id, local_n };
	return { status: "adjusted", reason: "Folio de serie del dispositivo", row };
}

function enqueue_cfdi(
	authority: Authority,
	payload: Record<string, unknown>,
): MutationResult {
	const id = text(payload.id);
	const sold_at = Number(payload.sold_at ?? 0);
	const total = Number(payload.total ?? 0);
	if (!id || !Number.isFinite(sold_at)) {
		return { status: "rejected", reason: "CFDI incompleto", row: null };
	}
	if (!authority.cfdi.some((item) => item.id === id)) {
		authority.cfdi.push({ id, sold_at, total });
	}
	const now = Number(payload.now ?? sold_at);
	const state = cfdi_queue_state(sold_at, now);
	return {
		status: "applied",
		reason: state,
		row: { id, state },
	};
}

function stamp_cfdi(
	authority: Authority,
	payload: Record<string, unknown>,
): MutationResult {
	const id = text(payload.id);
	const intent = authority.cfdi.find((item) => item.id === id);
	if (!intent) {
		return { status: "rejected", reason: "No hay CFDI encolado", row: null };
	}
	const now = Number(payload.now ?? Date.now());
	const state = cfdi_queue_state(intent.sold_at, now);
	if (state === "blocked") {
		return {
			status: "rejected",
			reason: "Bloqueado antes de las 72 h sin timbrar",
			row: { id, state },
		};
	}
	return {
		status: state === "alarm" ? "adjusted" : "applied",
		reason: state === "alarm" ? "Alarma: más de 24 h sin timbrar" : "Timbrado diferido",
		row: { id, state },
	};
}

function provisional_ticket(
	authority: Authority,
	payload: Record<string, unknown>,
): MutationResult {
	const id = text(payload.id);
	const total = Number(payload.total ?? 0);
	const folio = text(payload.folio);
	if (!id || !folio || !Number.isFinite(total)) {
		return { status: "rejected", reason: "Ticket provisional incompleto", row: null };
	}
	if (!authority.tickets.some((ticket) => ticket.id === id)) {
		authority.tickets.push({ id, total, folio });
	}
	const row = { id, total, folio, provisional: true };
	return { status: "applied", row };
}
