/**
 * Lo que el chat hace con el tiempo: cada 30 s caducan los mensajes temporales y las historias,
 * salen los programados, llegan los recordatorios de lo guardado y de las reuniones, las series de
 * reuniones pasan a su siguiente ocurrencia y se borran las subidas que nadie ligó en 24 h, igual
 * que las partes de grabaciones que nadie terminó. Lo vencido se reclama con `FOR UPDATE SKIP
 * LOCKED`; lo que una corrida anterior dejó reclamado vuelve a pendiente al arrancar, cuando nada
 * sigue en curso.
 */
import { publish_expired, remove_unused_files, send_scheduled } from './chat-flow.ts';
import { chat_settings } from './chat-settings.ts';
import { print_console_log } from './debug-request-log.ts';
import { as_object } from './envelope.ts';
import { advance_recurring_meetings, discard_stale_recordings, remind_due_meetings } from './meetings-flow.ts';
import { insert_notification } from './notifications.ts';
import { is_missing_relation, type ImperiumStore } from './store.ts';

const TICK_MS = 30_000;
const FIRST_PASS_MS = 5_000;
const BATCH = 100;
const BATCHES_PER_PASS = 20;
const ORPHAN_UPLOAD_MS = 24 * 3600_000;

function report(err: unknown): void {
	print_console_log('error', `chat: la pasada de trabajos falló: ${err instanceof Error ? err.message : String(err)}`);
}

/** Un lote de mensajes temporales vencidos; devuelve cuántos reclamó. Si la purga falla, los suelta. */
export async function expire_due_messages(store: ImperiumStore, now: Date, legal_hold: boolean): Promise<number> {
	const claimed = await store.chat_claim_due('expire', now.toISOString(), BATCH);
	if (!claimed.length) return 0;
	const ids = claimed.map((row) => String(row._id));
	let purge: Awaited<ReturnType<ImperiumStore['chat_purge_messages']>>;
	try {
		purge = await store.chat_purge_messages({ ids, now: now.toISOString(), legal_hold });
	} catch (err) {
		await store.chat_release_claims('expire', ids);
		throw err;
	}
	await remove_unused_files(store, purge.files);
	await publish_expired(store, purge);
	return claimed.length;
}

/** Un lote de subidas sin ligar de más de 24 h; devuelve cuántas dio de baja. */
export async function discard_orphan_uploads(store: ImperiumStore, now: Date): Promise<number> {
	const before = new Date(now.getTime() - ORPHAN_UPLOAD_MS).toISOString();
	const rows = await store.chat_discard_orphan_uploads(before, now.toISOString(), BATCH);
	await remove_unused_files(store, rows.map((row) => row.name_stored));
	return rows.length;
}

/** Un lote de programados vencidos. Lo que falle sin respuesta del flujo vuelve a pendiente. */
export async function send_due_scheduled(store: ImperiumStore, now: Date): Promise<number> {
	const claimed = await store.chat_claim_due('send', now.toISOString(), BATCH);
	for (const row of claimed) {
		try {
			await send_scheduled(store, row);
		} catch (err) {
			await store.chat_release_claims('send', [String(row._id)]);
			report(err);
		}
	}
	return claimed.length;
}

/**
 * Contrato §1.12: un recordatorio vencido de lo guardado llega como notificación a quien lo guardó,
 * solo si aún ve el mensaje; si no, queda reclamado sin aviso.
 */
export async function remind_due_saved(store: ImperiumStore, now: Date): Promise<number> {
	const claimed = await store.chat_claim_due('remind', now.toISOString(), BATCH);
	const visible = await store.chat_saved_still_visible(
		claimed.map((row) => String(row._id)),
		now.toISOString(),
	);
	for (const row of claimed.filter((item) => visible.has(String(item._id)))) {
		const conversation_id = String(row.conversationId ?? '');
		const message_id = String(row.message_id ?? '');
		await insert_notification(store, {
			recipientId: String(row.user_id),
			type: 'chat-reminder',
			title: 'Recordatorio de un mensaje guardado',
			message: String(row.note || as_object(row.preview).textPreview || ''),
			isRead: false,
			source: {
				kind: 'chat',
				action: 'reminder',
				conversationId: conversation_id,
				messageId: message_id,
				route: `/mensajes?chat_conversation_id=${conversation_id}&chat_message_id=${message_id}`,
			},
			payload: { saved_id: String(row._id) },
		});
	}
	return claimed.length;
}

/** Un lote de historias vencidas: salen con sus vistas y su archivo. */
export async function purge_expired_stories(store: ImperiumStore, now: Date): Promise<number> {
	const claimed = await store.chat_claim_due('story', now.toISOString(), BATCH);
	if (!claimed.length) return 0;
	const ids = claimed.map((row) => String(row._id));
	let dropped: Awaited<ReturnType<ImperiumStore['chat_drop_stories']>>;
	try {
		dropped = await store.chat_drop_stories(ids, now.toISOString(), null);
	} catch (err) {
		await store.chat_release_claims('story', ids);
		throw err;
	}
	await remove_unused_files(store, dropped.files);
	return claimed.length;
}

/** Un recordatorio reclamado ya quedó `notified`: no tiene nada que soltar. */
export async function close_pending_jobs(store: ImperiumStore): Promise<void> {
	await store.chat_release_claims('expire');
	await store.chat_release_claims('send');
	await store.chat_release_claims('story');
}

/** Repite el lote mientras salga lleno, con tope por pasada. */
async function drain(batch: () => Promise<number>): Promise<void> {
	for (let i = 0; i < BATCHES_PER_PASS; i++) if ((await batch()) < BATCH) return;
}

async function run_chat_jobs_pass(store: ImperiumStore, now = new Date()): Promise<void> {
	const settings = await chat_settings(store);
	await drain(() => expire_due_messages(store, now, settings.legal_hold));
	await drain(() => send_due_scheduled(store, now));
	await drain(() => remind_due_saved(store, now));
	await drain(() => purge_expired_stories(store, now));
	await drain(() => advance_recurring_meetings(store, now));
	await drain(() => remind_due_meetings(store, now));
	await drain(() => discard_orphan_uploads(store, now));
	discard_stale_recordings(now);
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let closed_pending = false;

export function start_chat_jobs(store: ImperiumStore): void {
	if (timer) return;
	const pass = async () => {
		if (running) return;
		running = true;
		try {
			if (!closed_pending) {
				await close_pending_jobs(store);
				closed_pending = true;
			}
			await run_chat_jobs_pass(store);
		} catch (err) {
			// Antes de que el arranque cree las tablas del chat no hay nada que hacer.
			if (!is_missing_relation(err)) report(err);
		} finally {
			running = false;
		}
	};
	timer = setInterval(() => void pass(), TICK_MS);
	timer.unref?.();
	setTimeout(() => void pass(), FIRST_PASS_MS).unref?.();
}
