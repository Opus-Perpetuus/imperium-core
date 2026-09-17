/**
 * Registro de trabajos largos del gestor (respaldos, VACUUM, REINDEX).
 *
 * Un `pg_dump` o un `REINDEX` de una tabla grande tardan minutos: sostener la
 * petición HTTP hasta el final deja al navegador esperando y al proxy cortando
 * a los 30 s. La ruta arranca el trabajo, devuelve su id y el front pregunta.
 *
 * Vive en memoria a propósito. El resultado duradero es el artefacto en disco y
 * la fila de bitácora; esto es solo el hilo para mirar mientras corre, y si el
 * núcleo se reinicia a media faena lo honesto es que el trabajo desaparezca de
 * la lista en vez de quedarse "en curso" para siempre.
 */

export type TaskStatus = 'running' | 'success' | 'error';

export type TaskLog = { at: string; message: string };

export type Task = {
	id: string;
	kind: string;
	label: string;
	status: TaskStatus;
	started_at: string;
	finished_at: string | null;
	logs: TaskLog[];
	result: unknown;
	error: string | null;
};

const MAX_LOGS = 200;
const MAX_TASKS = 50;

const tasks = new Map<string, Task>();

export type TaskHandle = {
	id: string;
	log: (message: string) => void;
};

/**
 * Arranca un trabajo y devuelve su ficha enseguida.
 *
 * `run` sigue corriendo después de que la ruta haya contestado; por eso captura
 * su propio error en vez de dejar una promesa sin dueño.
 */
export function start_task(
	kind: string,
	label: string,
	run: (handle: TaskHandle) => Promise<unknown>,
): Task {
	const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const task: Task = {
		id,
		kind,
		label,
		status: 'running',
		started_at: new Date().toISOString(),
		finished_at: null,
		logs: [],
		result: null,
		error: null,
	};
	tasks.set(id, task);
	prune();

	const handle: TaskHandle = {
		id,
		log: (message: string) => {
			task.logs.push({ at: new Date().toISOString(), message });
			if (task.logs.length > MAX_LOGS) task.logs.splice(0, task.logs.length - MAX_LOGS);
		},
	};

	void (async () => {
		try {
			task.result = await run(handle);
			task.status = 'success';
		} catch (err) {
			task.status = 'error';
			task.error = err instanceof Error ? err.message : String(err);
			handle.log(`Falló: ${task.error}`);
		} finally {
			task.finished_at = new Date().toISOString();
		}
	})();

	return task;
}

export function get_task(id: string): Task | null {
	return tasks.get(id) ?? null;
}

export function list_tasks(): Task[] {
	return [...tasks.values()].sort((a, b) =>
		b.started_at.localeCompare(a.started_at),
	);
}

/** ¿Hay ya uno de este tipo corriendo? Evita dos respaldos encimados. */
export function is_running(kind: string): boolean {
	for (const task of tasks.values()) {
		if (task.kind === kind && task.status === 'running') return true;
	}
	return false;
}

function prune(): void {
	if (tasks.size <= MAX_TASKS) return;
	const done = [...tasks.values()]
		.filter((t) => t.status !== 'running')
		.sort((a, b) => a.started_at.localeCompare(b.started_at));
	for (const task of done) {
		if (tasks.size <= MAX_TASKS) break;
		tasks.delete(task.id);
	}
}

/** Solo para pruebas: vacía el registro. */
export function reset_tasks(): void {
	tasks.clear();
}
