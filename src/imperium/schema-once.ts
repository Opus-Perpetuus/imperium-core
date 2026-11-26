// DDL de "asegurar tabla" (CREATE/ALTER ... IF NOT EXISTS) toma locks aunque no
// cambie nada; ALTER TABLE toma AccessExclusiveLock. Correrlo en cada petición
// hacía cola de locks bajo carga. Se corre una vez por cliente SQL y clave; si
// falla, el siguiente intento lo repite.
const ready = new WeakMap<object, Map<string, Promise<void>>>();

export function once_per_client(sql: Bun.SQL, key: string, run: () => Promise<void>): Promise<void> {
	const owner = sql as unknown as object;
	let by_key = ready.get(owner);
	if (!by_key) {
		by_key = new Map();
		ready.set(owner, by_key);
	}
	let done = by_key.get(key);
	if (!done) {
		done = run();
		by_key.set(key, done);
		const map = by_key;
		done.catch(() => map.delete(key));
	}
	return done;
}

/** Olvida lo asegurado (p. ej. la tabla desapareció tras una restauración). */
export function forget_once(sql: Bun.SQL, key: string): void {
	ready.get(sql as unknown as object)?.delete(key);
}
