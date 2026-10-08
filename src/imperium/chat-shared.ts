/** Lo que comparten los flujos del chat: mensajes, llamadas, reuniones e historias. */
import { ChatError } from './chat-access.ts';
import { chat_settings, type ChatSettings } from './chat-settings.ts';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export const CHAT_ID = /^[a-f0-9]{24}$/i;

export function str(value: unknown): string {
	return value == null ? '' : String(value).trim();
}

export function defined<T extends Record<string, unknown>>(rec: T): T {
	for (const key of Object.keys(rec)) if (rec[key] === undefined) delete rec[key];
	return rec;
}

export function invalid(message = 'La petición no es válida.'): ChatError {
	return new ChatError(422, 'invalid_request', message);
}

export function new_id(): string {
	return crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

export function actor_id(ctx: { actor: ImperiumDoc | null }): string {
	return str(ctx.actor?._id);
}

export async function calls_enabled_settings(store: ImperiumStore): Promise<ChatSettings> {
	const settings = await chat_settings(store);
	if (!settings.calls_enabled) {
		throw new ChatError(403, 'calls_disabled', 'Las llamadas están desactivadas en esta organización.');
	}
	return settings;
}

/** Multipart manda los objetos como texto JSON. */
export function json_field(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		throw invalid();
	}
}

export function encode_cursor(at: string, id: string): string {
	return Buffer.from(JSON.stringify({ at, id })).toString('base64url');
}

export function invalid_cursor(): ChatError {
	return new ChatError(400, 'invalid_cursor', 'La página solicitada ya no es válida; recarga la lista.');
}

export function decode_cursor(raw: string): { at: string; id: string } {
	try {
		const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
		if (typeof value.at === 'string' && typeof value.id === 'string') return { at: value.at, id: value.id };
	} catch {
		/* cae al error de abajo */
	}
	throw invalid_cursor();
}

/** Una hoja de cálculo ejecuta como fórmula la celda que empieza con `= + - @`, tabulador o salto. */
function formula_safe(text: string): string {
	return /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text;
}

export function csv_cell(value: string): string {
	const safe = formula_safe(value);
	return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function quoted_csv_cell(value: string | number): string {
	return `"${formula_safe(String(value)).replace(/"/g, '""')}"`;
}
