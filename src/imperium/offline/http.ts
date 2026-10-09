import { replay_durable, type SyncStore } from "./durable";
import type { NamedMutation } from "./types";

export async function handle_sync_http(
	req: Request,
	path: string,
	store: SyncStore,
): Promise<Response> {
	if (req.method !== "POST" || path !== "/sync/v1/mutaciones") {
		return Response.json(
			{ message: "Ruta de sync desconocida", error: "Ruta de sync desconocida" },
			{ status: 404 },
		);
	}
	const body = (await req.json()) as {
		server_id?: string;
		mutations?: NamedMutation[];
	};
	const server_id = String(body.server_id ?? "").trim();
	if (!server_id) {
		return Response.json(
			{ message: "Falta el servidor", error: "Falta el servidor" },
			{ status: 400 },
		);
	}
	const mutations = (Array.isArray(body.mutations) ? body.mutations : []).map((mutation) => ({
		...mutation,
		server_id: mutation.server_id || server_id,
	}));
	const results = await replay_durable(store, mutations);
	return Response.json({ results });
}
