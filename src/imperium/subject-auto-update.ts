/**
 * Actualización automática de apps.
 *
 * Apagada por defecto: el interruptor es el parámetro de sistema
 * `configuration-subject-auto-update-enabled`. Cuando está en SI, cada pasada
 * busca apps instaladas con una versión más nueva y las actualiza de una en
 * una, dependencias primero. La versión es el pin del catálogo o, si
 * `configuration-subject-auto-update-discovered` también está en SI, la que el
 * núcleo descubrió en el registro, pero solo cuando lleva construida al menos
 * `configuration-subject-auto-update-min-age-hours` (24 por defecto).
 *
 * Vive aquí y NO en el operador: `subject-operator.ts` solo monta el HTTP del
 * runtime, no tiene ni `Bun.SQL` ni `ImperiumStore`. Como el proceso del
 * operador arranca con ese fichero, nunca ejecuta esta pasada — que es lo
 * correcto: si lo hicieran los dos, dos procesos actualizarían la misma app.
 */
import type { ImperiumStore } from './store.ts';
import {
	accept_subject_update,
	backfill_installed_images,
	installed_image_of,
	list_subject_updates,
	subject_image_tag,
	SubjectLifecycleError,
} from './subjects-admin.ts';
import { print_console_log } from './debug-request-log.ts';
import { discover_subject_versions } from './subject-discovery.ts';
import { plan_subject_install, type DependencyNode } from './subject-deps.ts';
import {
	coerce_flag,
	coerce_hours,
	read_config_value,
	soaked,
	SUBJECT_AUTO_UPDATE_MIN_AGE_REF,
} from './subject-versions.ts';

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
	return coerce_flag(value);
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
	/** Ocupadas (ellas o una dependencia) con otro trabajo: otra pasada las verá. */
	skipped: string[];
	/** `slug→X.Y.Z` encontradas en el registro, se instalen o no en esta pasada. */
	discovered: string[];
};

/** Dependencias primero: una app que depende de otra se actualiza después de ella. */
export function dependencies_first<T extends { technical_id: string }>(
	items: readonly T[],
	subjects: readonly DependencyNode[],
): T[] {
	const order: string[] = [];
	for (const item of items) {
		let plan: string[];
		try {
			plan = plan_subject_install(subjects, item.technical_id, () => false);
		} catch {
			plan = [item.technical_id];
		}
		for (const tid of plan) if (!order.includes(tid)) order.push(tid);
	}
	return [...items].sort(
		(a, b) => order.indexOf(a.technical_id) - order.indexOf(b.technical_id),
	);
}

/**
 * Una pasada. Secuencial a propósito: cada actualización es un `docker pull`
 * y hacerlas a la vez satura la red del host y deja varias apps a medias.
 * Entra por la misma admisión que el botón: registra el trabajo, salta las
 * apps ocupadas e instala antes las dependencias que falten.
 */
export async function run_subject_auto_update_pass(
	store: ImperiumStore,
	sql: Bun.SQL,
): Promise<AutoUpdatePass> {
	const enabled = await read_subject_auto_update_enabled(store);
	if (!enabled) {
		return { enabled: false, checked: 0, updated: [], failed: [], skipped: [], discovered: [] };
	}
	// Sin la imagen que corre no hay con qué comparar: la pasada no esperaba a
	// que alguien pulsara «Buscar» para averiguarla.
	await backfill_installed_images(store, sql);
	const discovery = await discover_subject_versions(store, sql).catch((err) => {
		print_console_log('warning', `auto-update: no se pudo consultar el registro: ${err}`);
		return null;
	});
	const min_age_hours = coerce_hours(
		await read_config_value(store, SUBJECT_AUTO_UPDATE_MIN_AGE_REF),
	);
	const now = Date.now();
	// Además del interruptor (que decide la política del servidor), la pasada
	// exige la espera. La admisión vuelve a calcular el objetivo con esta misma
	// regla y las filas del momento.
	const accept_discovered = (created_at: string | null) =>
		soaked(created_at, min_age_hours, now);
	const pending = dependencies_first(
		await list_subject_updates(store, sql, { accept_discovered }),
		store.subjects,
	);
	const out: AutoUpdatePass = {
		enabled: true,
		checked: pending.length,
		updated: [],
		failed: [],
		skipped: [],
		discovered: discovery?.found ?? [],
	};
	for (const item of pending) {
		let error: string | null;
		let tag = item.available_tag;
		try {
			const accepted = await accept_subject_update(
				store,
				sql,
				item.technical_id,
				null,
				{ accept_discovered, only_if_newer: true },
			);
			if (!accepted) continue;
			if (accepted.already_running) {
				out.skipped.push(item.slug);
				print_console_log(
					'info',
					`auto-update: ${item.slug} ocupada, se deja para la próxima pasada`,
				);
				continue;
			}
			// La admisión recalcula el objetivo: puede no ser el de la lista.
			tag = subject_image_tag(accepted.image) || tag;
			error = await accepted.done;
			// Y si la descubierta no pasó la revisión, se instaló el pin.
			const now_running = await installed_image_of(sql, item.technical_id);
			if (!error && now_running && now_running !== item.installed_image) {
				tag = subject_image_tag(now_running);
			}
		} catch (err) {
			if (err instanceof SubjectLifecycleError && err.code === 'dependency_busy') {
				out.skipped.push(item.slug);
				print_console_log(
					'info',
					`auto-update: ${item.slug} se deja para la próxima pasada: ${err.message}`,
				);
				continue;
			}
			error = err instanceof Error ? err.message : String(err);
		}
		if (error) {
			// Una app que falla no detiene a las demás.
			out.failed.push({ slug: item.slug, error });
			print_console_log('error', `auto-update: ${item.slug} falló: ${error}`);
			continue;
		}
		out.updated.push(`${item.slug}→${tag}`);
		print_console_log(
			'info',
			`auto-update: ${item.slug} ${subject_image_tag(item.installed_image)} → ${tag}`,
		);
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
