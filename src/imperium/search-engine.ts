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
		return collection.replace(/[^a-zA-Z0-9_-]/g, '_');
	}

	async index_documents(collection: string, docs: SearchDocument[]) {
		if (!docs.length || !this.is_enabled()) return;
		try {
			await this.ensure_index(collection);
			const res = await this.request(
				'POST',
				`/indexes/${this.uid(collection)}/documents?primaryKey=id`,
				docs,
			);
			this.mark_available(Boolean(res?.ok));
			if (res?.ok) await this.wait_task(res);
		} catch (error) {
			this.mark_available(false);
			this.log_error(error);
		}
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
	add(doc.search_field);
	for (const [key, value] of Object.entries(doc)) {
		if (key.startsWith('_') || key === 'payload' || key === 'custom_data') continue;
		if (typeof value === 'string' || typeof value === 'number') add(value);
	}
	for (const value of Object.values(as_object(doc.payload))) {
		if (typeof value === 'string' || typeof value === 'number') add(value);
	}
	return parts.join(' ').replace(/\s+/g, ' ').trim();
}
