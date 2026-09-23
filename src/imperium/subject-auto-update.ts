/**
 * Actualización automática de apps.
 *
 * Apagada por defecto: el interruptor es el parámetro de sistema
 * `configuration-subject-auto-update-enabled`. Cuando está en SI, cada pasada
 * busca apps instaladas cuya imagen no coincide con el pin del catálogo y las
 * actualiza de una en una.
 *
 * Vive aquí y NO en el operador: `subject-operator.ts` solo monta el HTTP del
 * runtime, no tiene ni `Bun.SQL` ni `ImperiumStore`. Como el proceso del
 * operador arranca con ese fichero, nunca ejecuta esta pasada — que es lo
 * correcto: si lo hicieran los dos, dos procesos actualizarían la misma app.
 */
import type { ImperiumStore } from './store.ts';
import {
	list_subject_updates,
	run_subject_update,
	subject_image_tag,
} from './subjects-admin.ts';
import { print_console_log } from './debug-request-log.ts';

export const SUBJECT_AUTO_UPDATE_ENABLED_REF =
	'configuration-subject-auto-update-enabled';

/** Cada 6 h. La ventana no es crítica: el pin cambia como mucho una vez al día. */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Margen tras arrancar, para no competir con el alta de esquemas. */
const DEFAULT_FIRST_DELAY_MS = 5 * 60 * 1000;

/**
 * `value` es JSONB y hay filas migradas de Mongo que vuelven envueltas
 * (`'"false"'`, a veces dos veces). Un `Boolean('"false"')` daría `true` y
 * encendería sola una función que el usuario dejó apagada, así que se
 * desenvuelve hasta el fondo y solo un SÍ explícito cuenta como SÍ.
 */
export function coerce_auto_update_flag(value: unknown): boolean {
	let current = value;
	for (let i = 0; i < 5; i++) {
		if (typeof current !== 'string') break;
		const text = current.trim();
		if (
			text.length > 1 &&
			((text.startsWith('"') && text.endsWith('"')) ||
				(text.startsWith("'") && text.endsWith("'")))
		) {
			current = text.slice(1, -1);
			continue;
		}
		break;
	}
	if (typeof current === 'boolean') return current;
	if (typeof current === 'number') return current === 1;
	if (typeof current !== 'string') return false;
	const text = current.trim().toLowerCase();
	return text === 'true' || text === 'si' || text === 'sí' || text === '1';
}

/** Lee el interruptor. Cualquier problema = apagado: nunca se activa sola. */
export async function read_subject_auto_update_enabled(
	store: ImperiumStore,
): Promise<boolean> {
	try {
		if (!store.has('configuration')) return false;
		const doc = await store.find_where('configuration', {
			_ref: SUBJECT_AUTO_UPDATE_ENABLED_REF,
		});
		if (!doc) return false;
		return coerce_auto_update_flag(doc.value);
	} catch {
		return false;
	}
}

/**
 * Escribe el interruptor. Devuelve el valor que quedó guardado.
 *
 * La fila la crea la semilla al arrancar; si no está (instancia sin el
 * recurso `configuration`), no se inventa nada y se informa de que no se pudo.
 */
export async function write_subject_auto_update_enabled(
	store: ImperiumStore,
	enabled: boolean,
): Promise<{ ok: boolean; enabled: boolean }> {
	try {
		if (!store.has('configuration')) return { ok: false, enabled: false };
		const doc = await store.find_where('configuration', {
			_ref: SUBJECT_AUTO_UPDATE_ENABLED_REF,
		});
		if (!doc?._id) return { ok: false, enabled: false };
		await store.update('configuration', String(doc._id), {
			value: enabled,
		} as never);
		return { ok: true, enabled };
	} catch {
		return { ok: false, enabled: false };
	}
}

export type AutoUpdatePass = {
	enabled: boolean;
	checked: number;
	updated: string[];
	failed: Array<{ slug: string; error: string }>;
};

/**
 * Una pasada. Secuencial a propósito: cada actualización es un `docker pull`
 * y hacerlas a la vez satura la red del host y deja varias apps a medias.
 */
export async function run_subject_auto_update_pass(
	store: ImperiumStore,
	sql: Bun.SQL,
): Promise<AutoUpdatePass> {
	const enabled = await read_subject_auto_update_enabled(store);
	if (!enabled) {
		return { enabled: false, checked: 0, updated: [], failed: [] };
	}
	const pending = await list_subject_updates(store, sql);
	const out: AutoUpdatePass = {
		enabled: true,
		checked: pending.length,
		updated: [],
		failed: [],
	};
	for (const item of pending) {
		const sub = store.subjects.find(
			(s) => s.technical_id === item.technical_id,
		);
		if (!sub) continue;
		try {
			await run_subject_update(store, sql, sub, null);
			out.updated.push(`${item.slug}→${item.available_tag}`);
			print_console_log(
				'info',
				`auto-update: ${item.slug} ${subject_image_tag(item.installed_image)} → ${item.available_tag}`,
			);
		} catch (err) {
			// Una app que falla no detiene a las demás.
			out.failed.push({ slug: item.slug, error: String(err) });
			print_console_log(
				'error',
				`auto-update: ${item.slug} falló: ${String(err)}`,
			);
		}
	}
	return out;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Arranca el reloj. Idempotente: llamarla dos veces no duplica el temporizador.
 * `running` evita que una pasada lenta se solape con la siguiente.
 */
export function start_subject_auto_update(
	store: ImperiumStore,
	sql: Bun.SQL,
	options?: { interval_ms?: number; first_delay_ms?: number },
): void {
	if (timer) return;
	const from_env = Number(process.env.SUBJECT_AUTO_UPDATE_INTERVAL_MS);
	const wanted =
		options?.interval_ms ??
		(Number.isFinite(from_env) && from_env > 0 ? from_env : null);
	const interval_ms = wanted && wanted > 0 ? wanted : DEFAULT_INTERVAL_MS;
	const first_delay =
		options?.first_delay_ms ?? DEFAULT_FIRST_DELAY_MS;
	const pass = async () => {
		if (running) return;
		running = true;
		try {
			await run_subject_auto_update_pass(store, sql);
		} catch (err) {
			print_console_log('error', `auto-update: pasada falló: ${err}`);
		} finally {
			running = false;
		}
	};
	setTimeout(() => {
		void pass();
		timer = setInterval(() => void pass(), interval_ms);
		// No sostiene el proceso: si el núcleo va a parar, que pare.
		timer.unref?.();
	}, first_delay).unref?.();
}

/** Para los tests. */
export function stop_subject_auto_update(): void {
	if (timer) clearInterval(timer);
	timer = null;
	running = false;
}
