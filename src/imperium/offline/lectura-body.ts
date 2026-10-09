export function lectura_online_body<T extends Record<string, unknown>>(modelo: T): T {
	return { ...modelo };
}
