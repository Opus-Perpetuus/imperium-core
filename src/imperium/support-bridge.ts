/**
 * Interinstancia hacia el soporte de Codice en Odoo (addon `imperium_ticket_bridge`
 * de codice-progressio-infra). Contrato: docs/knowledge-base/topics/ops/soporte-odoo-tickets.md
 *
 * La llave TKSUPPORT la publica el gestor de servidores de Odoo en el `.env` del
 * núcleo. Solo viaja en la query hacia Odoo: nunca se guarda en el ticket ni sale
 * en una respuesta.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { raw_json_body } from './body.ts';
import { print_console_log } from './debug-request-log.ts';
import { outside_history_context, run_with_history_context } from './history.ts';
import type { ImperiumStore } from './store.ts';

const DEFAULT_BASE_URL = 'https://codice-progressio.online';
const TICKETS_PATH = '/imperium/api/v1/support-tickets';
const TIMEOUT_MS = 10_000;
const MAX_LOG_CHARS = 20_000;
const SYNC_INTERVAL_MS = 5 * 60_000;
const SYNC_FIRST_DELAY_MS = 60_000;
const STATUS_VALUES = new Set(['open', 'in_progress', 'resolved', 'closed']);

export const SUPPORT_SIGN_HEADER = 'x-imperium-sign';

type SupportState = {
	target?: string;
	endpoint?: string;
	forwarded?: boolean;
	forwardedAt?: string;
	responseStatus?: number;
	responseMessage?: string;
	externalTicketId?: string;
	rejected?: string;
	pendingUpdate?: Record<string, unknown>;
	pendingComments?: string[];
};

type SupportReply = { status: number; ok: boolean; text: string; json: Record<string, unknown> };

export type FlushResult = 'done' | 'retry' | 'blocked';

export type SupportCtx = {
	store: ImperiumStore;
	req: Request;
	url: URL;
	body: Record<string, unknown>;
};

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function now(): string {
	return new Date().toISOString();
}

export function support_key(): string {
	return String(process.env.TKSUPPORT ?? '').trim();
}

export function support_enabled(): boolean {
	return Boolean(support_key());
}

export function support_endpoint(suffix = ''): string {
	const base = (String(process.env.TKSUPPORT_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
	return `${base}${TICKETS_PATH}${suffix}`;
}

export function redact_support_key(value: unknown): string {
	let out = String(value ?? '').replace(/(tksupport=)[^&\s"']*/gi, '$1');
	const key = support_key();
	if (key) out = out.split(key).join('***');
	return out;
}

export function support_initial_state(): SupportState {
	return { target: 'odoo', endpoint: support_endpoint(), forwarded: false };
}

export function reporter_text(value: unknown): string {
	const reporter = as_object(value);
	const name = text(reporter.name);
	const email = text(reporter.email);
	if (name && email) return `${name} <${email}>`;
	return name || email || text(reporter.ip);
}

export function support_create_payload(ticket: ImperiumDoc): Record<string, unknown> {
	const data = as_object(ticket.instanceData);
	const version = text(data.version);
	const log = text(data.log);
	const description = [
		text(ticket.description),
		version ? `Versión: ${version}` : '',
		log ? `Log:\n${log.slice(0, MAX_LOG_CHARS)}` : '',
	]
		.filter(Boolean)
		.join('\n\n');
	return {
		title: text(ticket.title) || text(ticket.name),
		description,
		client_ref: String(ticket._id),
		source_type: text(ticket.sourceType),
		reporter: reporter_text(ticket.reporter),
		instance_label: text(data.label) || text(process.env.INSTANCE_LABEL),
		instance_url: text(data.url),
	};
}

export function valid_support_signature(key: string, raw: string, header: string | null): boolean {
	const presented = String(header ?? '').trim().toLowerCase();
	if (!key || !/^[0-9a-f]{64}$/.test(presented)) return false;
	const expected = createHmac('sha256', key).update(raw, 'utf8').digest('hex');
	return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(presented, 'hex'));
}

async function post_support(
	suffix: string,
	body: Record<string, unknown>,
	idempotency_key: string,
): Promise<SupportReply> {
	const url = `${support_endpoint(suffix)}?tksupport=${encodeURIComponent(support_key())}`;
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotency_key },
			body: JSON.stringify(body),
			// La llave va en la query: una redirección la mandaría a otro sitio.
			redirect: 'manual',
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const raw = await response.text();
		let json: Record<string, unknown> = {};
		try {
			json = as_object(JSON.parse(raw));
		} catch {
			json = {};
		}
		return {
			status: response.status,
			ok: response.ok,
			text: redact_support_key(raw).slice(0, 400),
			json,
		};
	} catch (error) {
		return {
			status: 0,
			ok: false,
			text: redact_support_key(error instanceof Error ? error.message : error).slice(0, 400),
			json: {},
		};
	}
}

const locks = new Map<string, Promise<unknown>>();

// El envío (red) va fuera del candado; solo las lecturas-escrituras del estado
// se forman, para que un comentario nuevo no pise el resultado de un envío.
function with_ticket_lock<T>(ticket_id: string, fn: () => Promise<T>): Promise<T> {
	const previous = locks.get(ticket_id) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(fn);
	const tail = next.catch(() => undefined);
	locks.set(ticket_id, tail);
	void tail.then(() => {
		if (locks.get(ticket_id) === tail) locks.delete(ticket_id);
	});
	return next;
}

function sync_value(state: SupportState): string {
	if (state.rejected) return 'failed';
	const pending =
		!text(state.externalTicketId) ||
		Object.keys(as_object(state.pendingUpdate)).length > 0 ||
		as_array(state.pendingComments).length > 0;
	return pending ? 'pending' : 'synced';
}

function patch_support_state(
	store: ImperiumStore,
	ticket_id: string,
	mutate: (state: SupportState) => void,
): Promise<ImperiumDoc | null> {
	return outside_history_context(() =>
		with_ticket_lock(ticket_id, async () => {
			const ticket = await store.find_id('tickets', ticket_id);
			if (!ticket) return null;
			const state = { ...as_object(ticket.interinstance) } as SupportState;
			if (state.target !== 'odoo') return null;
			mutate(state);
			return store.update('tickets', ticket_id, {
				interinstance: state,
				support_sync: sync_value(state),
			});
		}),
	);
}

function record_reply(state: SupportState, reply: SupportReply) {
	state.responseStatus = reply.status;
	state.responseMessage = reply.text;
}

async function flush_once(store: ImperiumStore, ticket_id: string): Promise<FlushResult> {
	const ticket = await store.find_id('tickets', ticket_id);
	const state = as_object(ticket?.interinstance) as SupportState;
	if (!ticket || state.target !== 'odoo' || state.rejected) return 'done';
	let external = text(state.externalTicketId);
	if (!external) {
		const reply = await post_support('', support_create_payload(ticket), ticket_id);
		const created_id = text(reply.json.id) || text(as_object(as_array(reply.json.data)[0])._id);
		await patch_support_state(store, ticket_id, (s) => {
			record_reply(s, reply);
			if (reply.ok && created_id) {
				s.externalTicketId = created_id;
				s.forwarded = true;
				s.forwardedAt = now();
			} else if (reply.status === 400) {
				s.rejected = text(reply.json.error) || 'invalid';
			}
		});
		// 404 = llave desconocida o servidor sin contacto/proyecto en Odoo. Cada
		// intento con llave mala suma al bloqueo por IP de Odoo: no seguir.
		if (!reply.ok || !created_id) return reply.status === 404 ? 'blocked' : 'retry';
		external = created_id;
	}
	const update = as_object(state.pendingUpdate);
	if (Object.keys(update).length) {
		const reply = await post_support(
			`/${encodeURIComponent(external)}/update`,
			{ client_ref: ticket_id, ...update },
			`${ticket_id}:update:${text(update.at)}`,
		);
		await patch_support_state(store, ticket_id, (s) => {
			record_reply(s, reply);
			if (!reply.ok) return;
			const pending = { ...as_object(s.pendingUpdate) };
			for (const [field, value] of Object.entries(update)) {
				if (JSON.stringify(pending[field]) === JSON.stringify(value)) delete pending[field];
			}
			s.pendingUpdate = Object.keys(pending).length ? pending : undefined;
		});
		if (!reply.ok) return 'retry';
	}
	for (const history_id of as_array(state.pendingComments).map(String)) {
		const row = await store.find_id('document-change-history', history_id);
		if (row) {
			const reply = await post_support(
				`/${encodeURIComponent(external)}/comment`,
				{
					client_ref: ticket_id,
					message_ref: history_id,
					text: text(row.comment ?? row.commentText),
					author: reporter_text(row.actor),
				},
				history_id,
			);
			await patch_support_state(store, ticket_id, (s) => record_reply(s, reply));
			if (!reply.ok) return 'retry';
		}
		await patch_support_state(store, ticket_id, (s) => {
			s.pendingComments = as_array(s.pendingComments)
				.map(String)
				.filter((id) => id !== history_id);
		});
	}
	return 'done';
}

const flushing = new Set<string>();
const flush_again = new Set<string>();

/** Manda a Odoo lo que el ticket tenga pendiente, en orden: alta, cambios, comentarios. */
export async function flush_support_ticket(
	store: ImperiumStore,
	ticket_id: string,
): Promise<FlushResult> {
	if (!support_enabled()) return 'done';
	if (flushing.has(ticket_id)) {
		flush_again.add(ticket_id);
		return 'done';
	}
	flushing.add(ticket_id);
	try {
		let result: FlushResult;
		do {
			flush_again.delete(ticket_id);
			result = await outside_history_context(() => flush_once(store, ticket_id));
		} while (result === 'done' && flush_again.has(ticket_id));
		return result;
	} finally {
		flushing.delete(ticket_id);
		flush_again.delete(ticket_id);
	}
}

function flush_later(store: ImperiumStore, ticket_id: string) {
	void flush_support_ticket(store, ticket_id).catch((error) =>
		print_console_log('error', `soporte: ${redact_support_key(error)}`),
	);
}

/** Alta ya guardada con `support_initial_state`: se manda sin detener la respuesta. */
export function queue_support_ticket(store: ImperiumStore, ticket: ImperiumDoc) {
	if (!support_enabled() || as_object(ticket.interinstance).target !== 'odoo') return;
	flush_later(store, String(ticket._id));
}

export async function queue_support_comment(
	store: ImperiumStore,
	ticket_id: string,
	history_id: string,
) {
	if (!support_enabled()) return;
	const saved = await patch_support_state(store, ticket_id, (s) => {
		const pending = as_array(s.pendingComments).map(String);
		if (!pending.includes(history_id)) pending.push(history_id);
		s.pendingComments = pending;
	});
	if (saved) flush_later(store, ticket_id);
}

export async function queue_support_update(
	store: ImperiumStore,
	before: ImperiumDoc,
	after: ImperiumDoc,
	actor: ImperiumDoc | null,
) {
	if (!support_enabled()) return;
	const changes: Record<string, unknown> = {};
	for (const field of ['title', 'description', 'status']) {
		const value = text(after[field]);
		if (value && value !== text(before[field])) changes[field] = value;
	}
	if (!Object.keys(changes).length) return;
	const ticket_id = String(after._id ?? before._id);
	const saved = await patch_support_state(store, ticket_id, (s) => {
		s.pendingUpdate = {
			...as_object(s.pendingUpdate),
			...changes,
			author: reporter_text(actor),
			at: now(),
		};
	});
	if (saved) flush_later(store, ticket_id);
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function run_support_sync_pass(store: ImperiumStore): Promise<void> {
	if (!support_enabled() || !store.has('tickets')) return;
	for await (const page of store.scan('tickets', { where: { support_sync: 'pending' } })) {
		for (const row of page) {
			if ((await flush_support_ticket(store, String(row._id))) === 'blocked') return;
		}
	}
}

/** Reintenta lo que no llegó (Odoo caído, llave aún sin publicar, ruta aún sin desplegar). */
export function start_support_sync(store: ImperiumStore): void {
	if (timer || !support_enabled()) return;
	const pass = async () => {
		if (running) return;
		running = true;
		try {
			await run_support_sync_pass(store);
		} catch (error) {
			print_console_log('error', `soporte: pasada falló: ${redact_support_key(error)}`);
		} finally {
			running = false;
		}
	};
	setTimeout(() => {
		void pass();
		timer = setInterval(() => void pass(), SYNC_INTERVAL_MS);
		timer.unref?.();
	}, SYNC_FIRST_DELAY_MS).unref?.();
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
};

/** Odoo quita las etiquetas del cuerpo del mensaje pero deja las entidades. */
export function decode_html_entities(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, code: string) => {
		const lower = code.toLowerCase();
		const point = lower.startsWith('#x')
			? Number.parseInt(lower.slice(2), 16)
			: lower.startsWith('#')
				? Number(lower.slice(1))
				: Number.NaN;
		if (Number.isInteger(point) && point > 0 && point <= 0x10ffff) return String.fromCodePoint(point);
		return NAMED_ENTITIES[lower] ?? entity;
	});
}

function reply(status: number, message: string): Response {
	return Response.json({ data: [], total_elementos: 0, message, error: message }, { status });
}

async function notify_ticket_people(store: ImperiumStore, ticket: ImperiumDoc, sender: string, body: string) {
	if (!store.has('notifications')) return;
	const recipients = new Set(
		[as_object(ticket.reporter).userId, ticket.assignedUserId ?? ticket.assigned_user_id]
			.map(text)
			.filter(Boolean),
	);
	const title = text(ticket.title) || 'Ticket de soporte';
	for (const recipient of recipients) {
		await store.insert('notifications', {
			name: 'Respuesta de soporte',
			title: 'Respuesta de soporte',
			message: `${sender}: ${body}`.slice(0, 500),
			type: 'ticket',
			recipientId: recipient,
			isRead: false,
			is_active: true,
			source: {
				kind: 'ticket',
				action: 'support_reply',
				modelName: 'Ticket',
				collectionName: '__tickets',
				documentId: ticket._id,
				route: `/internal/tickets?ticket_id=${encodeURIComponent(String(ticket._id))}`,
				entityLabel: title,
			},
			payload: { ticket_id: ticket._id },
		});
	}
}

/**
 * Aviso de Odoo (comentario público o cambio de estado) firmado con la llave.
 * Odoo reintenta en 6 h ante 404/410 y descarta ante cualquier otro 4xx.
 */
export async function receive_support_comment(ctx: SupportCtx): Promise<Response> {
	const key = support_key();
	if (!key) return reply(404, 'Esta instancia no tiene llave de soporte.');
	if (!valid_support_signature(key, raw_json_body(ctx.req), ctx.req.headers.get(SUPPORT_SIGN_HEADER))) {
		return reply(401, 'Firma de soporte inválida.');
	}
	const ticket_id = text(ctx.body.client_ref);
	const message_id = text(ctx.body.message_id);
	if (!ticket_id || !message_id) return reply(422, 'El aviso no trae client_ref ni message_id.');
	const ticket = ctx.store.has('tickets') ? await ctx.store.find_id('tickets', ticket_id) : null;
	const external = text(as_object(ticket?.interinstance).externalTicketId);
	const related = text(ctx.body.related_ticket_id);
	if (!ticket || (external && related && external !== related)) {
		return reply(422, 'El aviso no corresponde a un ticket de esta instancia.');
	}
	const already = await ctx.store.find_where('document-change-history', {
		documentId: ticket_id,
		support_message_id: message_id,
	});
	if (already) return Response.json(ok([{ _id: ticket_id }], 'Aviso de soporte ya recibido.'));
	const sender = text(ctx.body.sender) || 'Soporte';
	const body = decode_html_entities(text(ctx.body.text));
	const author = { name: `${sender} (soporte)` };
	if (body) {
		await ctx.store.insert('document-change-history', {
			name: 'comentario',
			entryType: 'comment',
			comment: body,
			commentText: body,
			actionName: 'Respuesta de soporte',
			actionDescription: body,
			model: 'tickets',
			modelName: 'tickets',
			collectionName: 'tickets',
			documentId: ticket_id,
			record_id: ticket_id,
			operationType: 'comment',
			mentionedUserIds: [],
			mentionedUsers: [],
			actor: author,
			support_message_id: message_id,
		});
		await notify_ticket_people(ctx.store, ticket, sender, body);
	}
	const status = text(ctx.body.status);
	if (STATUS_VALUES.has(status) && status !== text(ticket.status) && ticket.isLockedByAssignment !== true) {
		await run_with_history_context(
			{ actor: author, method: ctx.req.method, path: ctx.url.pathname },
			() => ctx.store.update('tickets', ticket_id, { status, estado: status }),
		);
	}
	return Response.json(ok([{ _id: ticket_id }], 'Aviso de soporte recibido.'));
}
