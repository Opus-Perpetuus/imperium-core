/**
 * Motor de búsqueda externo (Meilisearch), mismo contrato que
 * `search-engine.service.ts`: si falla, el llamador cae al ILIKE de SQL.
 */
import { as_object, type ImperiumDoc } from './envelope.ts';

export type SearchDocument = { id: string; search_text: string };

const AVAILABILITY_TTL_MS = 30 * 1000;

function meili_url() {
	return String(process.env.MEILI_URL ?? '').trim().replace(/\/+$/, '');
}

function meili_key() {
	return String(process.env.MEILI_MASTER_KEY ?? '').trim();
}

class SearchEngineService {
	private available = false;
	private availability_checked_at = 0;
	private ensured = new Set<string>();
	private error_logged = false;
	private background: Promise<void> = Promise.resolve();

	is_enabled() {
		return Boolean(meili_url());
	}

	is_active() {
		return this.is_enabled() && this.available;
	}

	async ensure_available(force = false) {
		if (!this.is_enabled()) {
			this.available = false;
			return false;
		}
		const now = Date.now();
		if (!force && now - this.availability_checked_at < AVAILABILITY_TTL_MS) {
			return this.available;
		}
		this.availability_checked_at = now;
		try {
			const res = await this.request('GET', '/health');
			this.available = Boolean(res?.ok);
		} catch {
			this.available = false;
		}
		return this.available;
	}

	uid(collection: string) {
		const safe = collection.replace(/[^a-zA-Z0-9_-]/g, '_');
		/* Prefijo propio: el Meili compartido con el Node original trae
		 * índices homónimos (~5000 docs sin `search_text`) que vacían termino. */
		return `imp_${safe}`;
	}

	/**
	 * `wait: false` encola en Meili y regresa sin esperar a que termine la tarea.
	 * El guardado de un registro lo usa: esperar cada tarea (pedido, productos,
	 * kardex, historial, bitácora) sumaba ~200 ms por documento y un pedido de
	 * 37 partidas tardaba 35 s (503 en el proxy). Meili procesa en orden, así que
	 * el documento aparece en la búsqueda unos cientos de ms después.
	 */
	async index_documents(
		collection: string,
		docs: SearchDocument[],
		opts: { wait?: boolean } = {},
	) {
		if (!docs.length || !this.is_enabled()) return;
		try {
			await this.ensure_index(collection);
			const res = await this.request(
				'POST',
				`/indexes/${this.uid(collection)}/documents?primaryKey=id`,
				docs,
			);
			this.mark_available(Boolean(res?.ok));
			if (res?.ok && opts.wait !== false) await this.wait_task(res);
		} catch (error) {
			this.mark_available(false);
			this.log_error(error);
		}
	}

	in_background(task: () => Promise<void>): Promise<void> {
		this.background = this.background
			.then(() => (this.failed_recently() ? undefined : task()))
			.catch(() => undefined);
		return this.background;
	}

	private failed_recently() {
		return !this.available && Date.now() - this.availability_checked_at < AVAILABILITY_TTL_MS;
	}

	async delete_documents(collection: string, ids: string[]) {
		if (!ids.length || !this.is_enabled()) return;
		try {
			for (const id of ids) {
				await this.request(
					'DELETE',
					`/indexes/${this.uid(collection)}/documents/${encodeURIComponent(id)}`,
				);
			}
		} catch (error) {
			this.mark_available(false);
			this.log_error(error);
		}
	}

	async search_ids(collection: string, term: string, limit = 1000) {
		if (!this.is_enabled()) return null;
		try {
			const res = await this.request(
				'POST',
				`/indexes/${this.uid(collection)}/search`,
				{ q: term, limit, attributesToRetrieve: ['id'] },
			);
			if (!res?.ok) {
				this.mark_available(false);
				return null;
			}
			const body = (await res.json()) as { hits?: Array<{ id?: unknown }> };
			this.mark_available(true);
			return (body.hits ?? []).map((hit) => String(hit.id ?? '')).filter(Boolean);
		} catch (error) {
			this.mark_available(false);
			this.log_error(error);
			return null;
		}
	}

	async index_is_empty(collection: string) {
		if (!this.is_enabled()) return true;
		try {
			const res = await this.request('GET', `/indexes/${this.uid(collection)}/stats`);
			if (!res?.ok) return true;
			const stats = (await res.json()) as { numberOfDocuments?: number };
			return (stats.numberOfDocuments ?? 0) === 0;
		} catch {
			return true;
		}
	}

	async clear_index(collection: string) {
		if (!this.is_enabled()) return;
		try {
			await this.ensure_index(collection);
			await this.request('DELETE', `/indexes/${this.uid(collection)}/documents`);
		} catch (error) {
			this.log_error(error);
		}
	}

	private async wait_task(res: Response) {
		const body = (await res.clone().json().catch(() => ({}))) as { taskUid?: number };
		const uid = body.taskUid;
		if (uid == null) return;
		for (let i = 0; i < 20; i++) {
			const task = await this.request('GET', `/tasks/${uid}`);
			const data = (await task?.json().catch(() => ({}))) as { status?: string };
			if (data.status === 'succeeded' || data.status === 'failed') return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	private async ensure_index(collection: string) {
		const uid = this.uid(collection);
		if (this.ensured.has(uid)) return;
		await this.request('POST', '/indexes', { uid, primaryKey: 'id' });
		await this.request('PUT', `/indexes/${uid}/settings/searchable-attributes`, [
			'search_text',
		]);
		this.ensured.add(uid);
	}

	private mark_available(value: boolean) {
		this.available = value;
		this.availability_checked_at = Date.now();
		if (value) this.error_logged = false;
	}

	private async request(method: string, path: string, body?: unknown) {
		const host = meili_url();
		if (!host) return null;
		const headers: Record<string, string> = { accept: 'application/json' };
		const key = meili_key();
		if (key) headers.authorization = `Bearer ${key}`;
		if (body !== undefined) headers['content-type'] = 'application/json';
		return fetch(`${host}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(4000),
		});
	}

	private log_error(error: unknown) {
		if (this.error_logged) return;
		this.error_logged = true;
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[search] Meilisearch no disponible, usando fallback SQL: ${message}`);
	}
}

export const SearchEngine = new SearchEngineService();

/**
 * Campos que no son texto de búsqueda (#268): el propio `search_field` (meterlo hacía que el
 * texto creciera en cada reindexado y nunca coincidiera con el guardado) y las marcas técnicas
 * (`updated_at` cambia en cada escritura, así que el texto siempre «cambiaba»).
 */
const SEARCH_TECHNICAL_KEYS = new Set([
	'search_field',
	'id',
	'created_at',
	'updated_at',
	'createdAt',
	'updatedAt',
	'deleted_at',
	'deletedAt',
	'created_by',
	'updated_by',
	'createdBy',
	'updatedBy',
	'__v',
]);

/** El texto de búsqueda que sale de los datos del documento, sin su `search_field` ni campos técnicos. */
export function search_text_from_doc(doc: ImperiumDoc) {
	const seen = new Set<string>();
	const parts: string[] = [];
	const add = (value: unknown) => {
		if (value == null) return;
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			const text = String(value).trim();
			if (text && !seen.has(text)) {
				seen.add(text);
				parts.push(text);
			}
		}
	};
	add(doc.name);
	add(doc.description);
	add(doc._ref);
	for (const [key, value] of Object.entries(doc)) {
		if (key.startsWith('_') || key === 'payload' || key === 'custom_data') continue;
		if (SEARCH_TECHNICAL_KEYS.has(key)) continue;
		if (typeof value === 'string' || typeof value === 'number') add(value);
	}
	for (const [key, value] of Object.entries(as_object(doc.payload))) {
		if (SEARCH_TECHNICAL_KEYS.has(key)) continue;
		if (typeof value === 'string' || typeof value === 'number') add(value);
	}
	return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function search_word(word: string) {
	return word.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * El `search_field` que debe quedar tras reindexar (#268): el guardado tal cual (lo escribe cada
 * dominio: pedidos con el cliente, debug_log, catálogos geo…) más las palabras de los datos que
 * le falten (sin distinguir mayúsculas ni acentos). Es idempotente: si ya trae todas, regresa el
 * guardado sin cambios y el reindexado no reescribe la fila.
 */
export function search_field_for_reindex(doc: ImperiumDoc) {
	const stored = typeof doc.search_field === 'string' ? doc.search_field.trim() : '';
	const have = new Set(stored.split(/\s+/).filter(Boolean).map(search_word));
	const missing: string[] = [];
	for (const word of search_text_from_doc(doc).split(/\s+/).filter(Boolean)) {
		const key = search_word(word);
		if (have.has(key)) continue;
		have.add(key);
		missing.push(word);
	}
	if (!missing.length) return stored;
	return [stored, missing.join(' ')].filter(Boolean).join(' ');
}

/** Lo que va a Meilisearch: el `search_field` del dominio más los datos, sin repetir palabras. */
export function search_index_text(doc: ImperiumDoc) {
	return search_field_for_reindex(doc);
}
