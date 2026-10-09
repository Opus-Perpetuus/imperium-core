import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	CORE_FUNCTION_POLICIES,
	abort_bootstrap,
	android_background_sync,
	app_policies,
	apply_mutation_batch,
	begin_bootstrap,
	catalog_slugs,
	cfdi_queue_state,
	commit_bootstrap,
	create_authority,
	create_change_log,
	create_device,
	desktop_background_sync,
	device_folio,
	enqueue_mutation,
	global_invoice_total,
	list_rows,
	logout,
	merge_field_edits,
	migrate_legacy_queue,
	open_node_sqlite,
	pending_for_server,
	policy_of,
	prepare_local_session,
	read_local,
	refuse_core_call,
	reset_version,
	run_offline_action,
	stage_bootstrap,
	switch_server,
	sync_device,
	unlock_with_pin,
	wasm_sqlite_options,
} from "./index";
import { confirmed_seqs, sqlite_imperium_sync } from "./durable";
import { handle_sync_http } from "./http";
import {
	capturar_lectura,
	queue_gps,
	queue_lectura,
	queue_logistics,
	queue_pedido,
	queue_pos_ticket,
	queue_violation,
} from "./app-queues";
import {
	APP_CREATE_FORMS,
	APP_EDIT_PATCH,
	enqueue_app_alta,
	online_alta_body,
} from "./app-alta";
import { confirm_gps_batch, gps_point_id, gps_puntos_body } from "./gps-puntos";
import { lectura_online_body } from "./lectura-body";
import { pos_ticket_online_body } from "./pos-ticket-body";
import { enqueue_alta_edit, pending_queue_ids, read_sync_device } from "./pouch-bridge";
import { open_sqlite_wasm, sqlite_wasm_supports_opfs, wasm_vfs } from "./sqlite-wasm";
import { remember_violation_outbox } from "../../../../../frontend/src/plugins/violation/violation-offline";

const HOUR = 60 * 60 * 1000;

describe("ventanas de cambios", () => {
	test("N escritores confirman fuera de orden y la unión cubre cada fila", () => {
		const log = create_change_log();
		const n = 8;
		const txs = Array.from({ length: n }, (_, index) => log.begin(`row-${index}`));
		const seen = new Set<string>();
		let cursor = 0;
		for (let index = n - 1; index >= 0; index -= 1) {
			log.commit(txs[index]!);
			const window = log.read_since(cursor);
			cursor = window.next_h;
			for (const id of window.row_ids) seen.add(id);
		}
		const tail = log.read_since(cursor);
		for (const id of tail.row_ids) seen.add(id);
		expect([...seen].sort()).toEqual(txs.map((tx) => tx.row_id).sort());
	});

	test("una transacción abierta no entra en la ventana", () => {
		const log = create_change_log();
		const hidden = log.begin("oculta");
		const window = log.read_since(0);
		expect(window.row_ids).toEqual([]);
		expect(hidden.committed).toBe(false);
	});
});

describe("reejecución", () => {
	test("el mismo lote N veces deja el mismo estado", () => {
		const batch = [
			{
				server_id: "s1",
				client_id: "c1",
				seq: 1,
				name: "record.create",
				version: 1,
				payload: { resource: "contacto", id: "c-1", fields: { nombre: "Ana" } },
			},
			{
				server_id: "s1",
				client_id: "c1",
				seq: 2,
				name: "record.edit",
				version: 1,
				payload: {
					resource: "contacto",
					id: "c-1",
					base: { nombre: "Ana" },
					patch: { nota: "local" },
				},
			},
		];
		const first = create_authority();
		const once = apply_mutation_batch(first, batch);
		const twice = apply_mutation_batch(first, batch);
		const third = apply_mutation_batch(first, batch);
		expect(once.map((item) => item.status)).toEqual(["applied", "applied"]);
		expect(twice).toEqual(once);
		expect(third).toEqual(once);
		expect(list_rows(first, "contacto")).toHaveLength(1);
		expect(list_rows(first, "contacto")[0]?.nota).toBe("local");
	});

	test("un corte a mitad del lote no deja filas parciales", () => {
		const authority = create_authority();
		expect(() =>
			apply_mutation_batch(authority, [
				{
					server_id: "s1",
					client_id: "c1",
					seq: 1,
					name: "record.create",
					version: 1,
					payload: { resource: "contacto", id: "c-1", fields: { nombre: "Ana" } },
				},
				{
					server_id: "s1",
					client_id: "c1",
					seq: 2,
					name: "test.fail",
					version: 1,
					payload: {},
				},
			]),
		).toThrow("Corte a mitad del lote");
		expect(list_rows(authority, "contacto")).toEqual([]);
	});
});

describe("fusión y folios y stock", () => {
	test("campos distintos se funden y el mismo campo crítico va a revisión", () => {
		const merged = merge_field_edits(
			{ nombre: "Ana", nota: "", calle: "" },
			{ nota: "uno" },
			{ calle: "Sur" },
		);
		expect(merged.ok).toBe(true);
		if (merged.ok) {
			expect(merged.merged.nota).toBe("uno");
			expect(merged.merged.calle).toBe("Sur");
		}
		const review = merge_field_edits(
			{ rfc: "AAA" },
			{ rfc: "BBB" },
			{ rfc: "CCC" },
		);
		expect(review.ok).toBe(false);
		if (!review.ok) expect(review.review_fields).toContain("rfc");
	});

	test("dos ediciones de campo crítico en el servidor quedan en revisión", () => {
		const authority = create_authority();
		apply_mutation_batch(authority, [
			{
				server_id: "s1",
				client_id: "a",
				seq: 1,
				name: "record.create",
				version: 1,
				payload: { resource: "contacto", id: "c-1", fields: { rfc: "AAA", nota: "" } },
			},
			{
				server_id: "s1",
				client_id: "a",
				seq: 2,
				name: "record.edit",
				version: 1,
				payload: {
					resource: "contacto",
					id: "c-1",
					base: { rfc: "AAA" },
					patch: { rfc: "BBB" },
				},
			},
		]);
		const conflict = apply_mutation_batch(authority, [
			{
				server_id: "s1",
				client_id: "b",
				seq: 1,
				name: "record.edit",
				version: 1,
				payload: {
					resource: "contacto",
					id: "c-1",
					base: { rfc: "AAA" },
					patch: { rfc: "CCC" },
				},
			},
		]);
		expect(conflict[0]?.status).toBe("conflict");
		expect(conflict[0]?.reason).toContain("rfc");
		expect(list_rows(authority, "contacto")[0]?.rfc).toBe("BBB");
	});

	test("dos dispositivos no comparten folio", () => {
		const left = device_folio("terminal-a", 1);
		const right = device_folio("terminal-b", 1);
		expect(left).not.toBe(right);
		const authority = create_authority();
		const results = apply_mutation_batch(authority, [
			{
				server_id: "s1",
				client_id: "a",
				seq: 1,
				name: "folio.issue",
				version: 1,
				payload: { device_id: "terminal-a", local_n: 1 },
			},
			{
				server_id: "s1",
				client_id: "b",
				seq: 1,
				name: "folio.issue",
				version: 1,
				payload: { device_id: "terminal-b", local_n: 1 },
			},
		]);
		expect(results.every((item) => item.status === "adjusted")).toBe(true);
		expect(authority.folios.size).toBe(2);
	});

	test("dos ventas del mismo SKU escaso se conservan y avisan", () => {
		const authority = create_authority();
		const results = apply_mutation_batch(authority, [
			{
				server_id: "s1",
				client_id: "a",
				seq: 1,
				name: "stock.sell",
				version: 1,
				payload: { sku: "SKU-1", qty: 1, sale_id: "v1", on_hand: 1 },
			},
			{
				server_id: "s1",
				client_id: "b",
				seq: 1,
				name: "stock.sell",
				version: 1,
				payload: { sku: "SKU-1", qty: 1, sale_id: "v2" },
			},
		]);
		expect(results[0]?.status).toBe("applied");
		expect(results[1]?.status).toBe("adjusted");
		expect(authority.stock.get("SKU-1")?.sales).toEqual(["v1", "v2"]);
		expect(authority.alerts).toHaveLength(1);
	});
});

describe("CFDI y factura global", () => {
	test("alarma a las 24 h y bloqueo antes de las 72 h", () => {
		const sold = Date.parse("2026-10-01T00:00:00Z");
		expect(cfdi_queue_state(sold, sold + 23 * HOUR)).toBe("pending");
		expect(cfdi_queue_state(sold, sold + 24 * HOUR)).toBe("alarm");
		expect(cfdi_queue_state(sold, sold + 70 * HOUR)).toBe("alarm");
		expect(cfdi_queue_state(sold, sold + 71 * HOUR)).toBe("blocked");
		expect(cfdi_queue_state(sold, sold + 72 * HOUR)).toBe("blocked");
		const authority = create_authority();
		apply_mutation_batch(authority, [
			{
				server_id: "s1",
				client_id: "c1",
				seq: 1,
				name: "cfdi.enqueue",
				version: 1,
				payload: { id: "cfdi-1", sold_at: sold, total: 10, now: sold },
			},
		]);
		const blocked = apply_mutation_batch(authority, [
			{
				server_id: "s1",
				client_id: "c1",
				seq: 2,
				name: "cfdi.stamp",
				version: 1,
				payload: { id: "cfdi-1", now: sold + 71 * HOUR },
			},
		]);
		expect(blocked[0]?.status).toBe("rejected");
		expect(blocked[0]?.reason).toContain("72");
	});

	test("la factura global suma los tickets provisionales", () => {
		const authority = create_authority();
		apply_mutation_batch(authority, [
			{
				server_id: "s1",
				client_id: "c1",
				seq: 1,
				name: "pos.ticket",
				version: 1,
				payload: { id: "t1", total: 10.5, folio: "terminal-a-1" },
			},
			{
				server_id: "s1",
				client_id: "c1",
				seq: 2,
				name: "pos.ticket",
				version: 1,
				payload: { id: "t2", total: 4.25, folio: "terminal-a-2" },
			},
		]);
		expect(
			global_invoice_total(
				authority.tickets.map((ticket) => ({ ...ticket, provisional: true })),
			),
		).toBe(14.75);
	});
});

describe("sesión local, reset y servidores", () => {
	test("el PIN abre la lectura local y no llama a la red", async () => {
		const device = create_device({ server_id: "srv-a", client_id: "dev-1" });
		const corte = "2026-10-09T15:04:00";
		await prepare_local_session(device, {
			pin: "2468",
			user: { _id: "u1", name: "Ana" },
			menu: [{ id: "ventas" }],
			corte_at: corte,
			rows: [
				{ resource: "contacto", id: "c-1", fields: { nombre: "Ana" } },
				{ resource: "contacto", id: "c-2", fields: { nombre: "Luis" } },
			],
		});
		const original = globalThis.fetch;
		globalThis.fetch = () => {
			throw new Error("red");
		};
		try {
			expect(await unlock_with_pin(device, "0000")).toBe(false);
			expect(await unlock_with_pin(device, "2468")).toBe(true);
			const read = read_local(device, { resource: "contacto", q: "ana" });
			expect(read.rows).toHaveLength(1);
			expect(read.stamp).toBe("al corte de las 15:04");
			expect(read.rows[0]?.nombre).toBe("Ana");
		} finally {
			globalThis.fetch = original;
		}
	});

	test("un bootstrap cortado no publica un corte a medias", () => {
		const device = create_device({ server_id: "srv-a", client_id: "dev-1" });
		device.unlocked = true;
		device.corte_at = "2026-10-09T10:00:00";
		device.catalog_rows = [
			{ resource: "contacto", id: "viejo", fields: { nombre: "Viejo" } },
		];
		begin_bootstrap(device);
		stage_bootstrap(device, [
			{ resource: "contacto", id: "nuevo", fields: { nombre: "Nuevo" } },
		]);
		abort_bootstrap(device);
		const read = read_local(device, { resource: "contacto" });
		expect(read.rows.map((row) => row.id)).toEqual(["viejo"]);
		begin_bootstrap(device);
		stage_bootstrap(device, [
			{ resource: "contacto", id: "nuevo", fields: { nombre: "Nuevo" } },
		]);
		commit_bootstrap(device, "2026-10-09T11:30:00");
		expect(read_local(device, { resource: "contacto" }).rows.map((row) => row.id)).toEqual([
			"nuevo",
		]);
	});

	test("reset, logout y cambio de servidor conservan la cola en su servidor", () => {
		const device = create_device({ server_id: "srv-a", client_id: "dev-1" });
		enqueue_mutation(device, {
			name: "record.create",
			payload: { resource: "pedidos", id: "p1", fields: { total: 3 } },
		});
		logout(device);
		reset_version(device);
		switch_server(device, "srv-b");
		enqueue_mutation(device, {
			name: "record.create",
			payload: { resource: "pedidos", id: "p2", fields: { total: 4 } },
		});
		expect(pending_for_server(device, "srv-a")).toHaveLength(1);
		expect(pending_for_server(device, "srv-b")).toHaveLength(1);
		const server_b = create_authority();
		sync_device(device, server_b);
		expect(list_rows(server_b, "pedidos").map((row) => row.id)).toEqual(["p2"]);
		expect(pending_for_server(device, "srv-a")).toHaveLength(1);
		expect(pending_for_server(device, "srv-b")).toEqual([]);
		switch_server(device, "srv-a");
		const server_a = create_authority();
		sync_device(device, server_a);
		expect(list_rows(server_a, "pedidos").map((row) => row.id)).toEqual(["p1"]);
	});

	test("matar el lote no tira la cola pendiente", () => {
		const device = create_device({ server_id: "srv-a", client_id: "dev-1" });
		enqueue_mutation(device, {
			name: "record.create",
			payload: { resource: "pedidos", id: "p1", fields: {} },
		});
		device.pending.push({
			server_id: "srv-a",
			client_id: "dev-1",
			seq: device.next_seq,
			name: "test.fail",
			version: 1,
			payload: {},
		});
		device.next_seq += 1;
		const authority = create_authority();
		expect(() => sync_device(device, authority)).toThrow("Corte a mitad del lote");
		expect(pending_for_server(device, "srv-a")).toHaveLength(2);
		expect(list_rows(authority, "pedidos")).toEqual([]);
	});
});

describe("políticas", () => {
	test("cada función del núcleo y cada app del catálogo tiene política", () => {
		const allowed = new Set(["si", "provisional", "diferido", "no"]);
		expect(CORE_FUNCTION_POLICIES.length).toBeGreaterThan(0);
		for (const item of CORE_FUNCTION_POLICIES) {
			expect(allowed.has(item.policy)).toBe(true);
			expect(policy_of(item.id)?.explanation.length).toBeGreaterThan(0);
		}
		const slugs = catalog_slugs();
		expect(slugs).toEqual(
			expect.arrayContaining(["predial", "ingresos", "presupuesto", "tramites"]),
		);
		const policies = app_policies();
		expect(policies.map((item) => item.slug)).toEqual(slugs);
		expect(policies).toHaveLength(slugs.length);
		for (const app of policies) {
			for (const policy of [app.create, app.edit, app.primary.policy]) {
				expect(allowed.has(policy)).toBe(true);
			}
		}
	});

	test("no rechaza la llamada y sí lee filas locales sin red", async () => {
		const refused = refuse_core_call("pago_tarjeta");
		expect(refused.refused).toBe(true);
		expect(refused.explanation.length).toBeGreaterThan(0);
		const device = create_device({ server_id: "srv-a", client_id: "dev-1" });
		await prepare_local_session(device, {
			pin: "2468",
			user: { _id: "u1" },
			menu: [],
			corte_at: "2026-10-09T08:00:00",
			rows: [{ resource: "contacto", id: "c-1", fields: { nombre: "Ana" } }],
		});
		await unlock_with_pin(device, "2468");
		const original = globalThis.fetch;
		let called = false;
		globalThis.fetch = () => {
			called = true;
			throw new Error("red");
		};
		try {
			const read = read_local(device, { resource: "contacto" });
			expect(called).toBe(false);
			expect(read.rows).toHaveLength(1);
		} finally {
			globalThis.fetch = original;
		}
	});

	test("crear, editar y la acción primaria de cada app siguen su política", () => {
		for (const app of app_policies()) {
			for (const action of ["create", "edit", "primary"] as const) {
				const device = create_device({ server_id: "srv-a", client_id: `dev-${app.slug}` });
				const authority = create_authority();
				const online = create_authority();
				const result = run_offline_action({
					device,
					authority,
					online,
					app: app.slug,
					action,
					record_id: `${app.slug}-1`,
				});
				const policy = action === "primary" ? app.primary.policy : app[action];
				expect(result.policy).toBe(policy);
				expect(result.explanation.length).toBeGreaterThan(0);
				expect(result.offline_rows).toBeUndefined();
				if (policy === "no") {
					expect(result.refused).toBe(true);
					expect(list_rows(authority, app.slug)).toEqual([]);
					expect(device.pending).toEqual([]);
				} else if (policy === "diferido") {
					const accion = action === "primary" ? app.primary.name : action;
					expect(result.deferred).toBe(true);
					expect(device.deferred.at(-1)?.payload.accion).toBe(accion);
					expect(device.deferred.at(-1)?.name).toBe(
						accion === "timbrar" ? "cfdi.enqueue" : accion,
					);
					expect(device.pending).toEqual([]);
				} else {
					expect(result.refused).toBeUndefined();
					expect(result.deferred).toBeUndefined();
					expect(device.pending).toEqual([]);
				}
			}
		}
	});
});

describe("colas viejas y almacenes", () => {
	test("migrar no tira pendientes y el reset tampoco", () => {
		const device = create_device({ server_id: "srv-a", client_id: "dev-1" });
		const rows = [{ id: "1", payload: { total: 9 } }];
		expect(migrate_legacy_queue(device, "violation", rows)).toBe(1);
		expect(migrate_legacy_queue(device, "violation", rows)).toBe(0);
		expect(migrate_legacy_queue(device, "agua", [{ id: "l1", payload: { m3: 2 } }])).toBe(1);
		reset_version(device);
		expect(pending_for_server(device, "srv-a").map((item) => item.payload.id)).toEqual([
			"1",
			"l1",
		]);
	});

	test("node:sqlite guarda la fila y la transacción que falla no la deja a medias", () => {
		const db = open_node_sqlite();
		db.put_row("contacto", "c-1", { nombre: "Ana" });
		expect(db.get_row("contacto", "c-1")?.nombre).toBe("Ana");
		expect(() =>
			db.transaction(() => {
				db.put_row("contacto", "c-2", { nombre: "Luis" });
				throw new Error("corte");
			}),
		).toThrow("corte");
		expect(db.get_row("contacto", "c-2")).toBeNull();
		db.put_pending("srv-a", "dev-1", 1, { name: "record.create" });
		db.put_pending("srv-a", "dev-1", 1, { name: "otra" });
		expect(db.list_pending("srv-a")).toHaveLength(1);
		db.close();
	});

	test("PWA abre el paquete oficial y el VFS de Safari es opfs-sahpool", async () => {
		expect(wasm_vfs(true)).toBe("opfs-sahpool");
		expect(wasm_vfs(false)).toBe("memory");
		expect(await sqlite_wasm_supports_opfs()).toBe(true);
		const db = await open_sqlite_wasm();
		db.put_row("perfil", "u1", { nombre: "Ana" });
		expect(db.get_row("perfil", "u1")?.nombre).toBe("Ana");
		expect(db.list_rows("perfil").map((row) => row.nombre)).toEqual(["Ana"]);
		expect(db.vfs).toBe("memory");
		db.close();
		const corte = await open_sqlite_wasm("imperium-corte");
		corte.put_row("perfil", "u1", { nombre: "Ana" });
		corte.close();
		const reopened = await open_sqlite_wasm("imperium-corte");
		expect(reopened.list_rows("perfil").map((row) => row.nombre)).toEqual(["Ana"]);
		reopened.close();
		expect(android_background_sync().runs_when_closed).toBe(true);
		expect(desktop_background_sync().runs_when_closed).toBe(true);
	});

	test("HTTP persiste la fila y un 2xx sin resultados no confirma la cola", async () => {
		const store = sqlite_imperium_sync();
		const payload = {
			server_id: "srv-http",
			mutations: [
				{
					server_id: "srv-http",
					client_id: "dev-1",
					seq: 1,
					name: "record.create",
					version: 1,
					payload: { resource: "contacto", id: "c-9", fields: { nombre: "Ana" } },
				},
			],
		};
		const post = () =>
			handle_sync_http(
				new Request("http://local/sync/v1/mutaciones", {
					method: "POST",
					body: JSON.stringify(payload),
				}),
				"/sync/v1/mutaciones",
				store,
			);
		const first = (await (await post()).json()) as {
			results: { status: string; row?: { id?: string } }[];
		};
		const second = (await (await post()).json()) as {
			results: { status: string; row?: { id?: string } }[];
		};
		expect(first.results[0]?.status).toBe("applied");
		expect(second.results[0]?.status).toBe("applied");
		expect(second.results[0]?.row?.id).toBe("c-9");
		expect((await store.find_id("contacto", "c-9"))?.nombre).toBe("Ana");
		expect(store.inserted()).toBe(1);
		expect(confirmed_seqs(first.results, payload.mutations)).toEqual([1]);
		expect(confirmed_seqs([{ ok: true } as { status?: string }], payload.mutations)).toEqual([]);
		store.close();
		const file = join(import.meta.dir, `.sync-restart-${Date.now()}.sqlite`);
		const disk = sqlite_imperium_sync(file);
		await handle_sync_http(
			new Request("http://local/sync/v1/mutaciones", {
				method: "POST",
				body: JSON.stringify(payload),
			}),
			"/sync/v1/mutaciones",
			disk,
		);
		expect((await disk.find_id("contacto", "c-9"))?.nombre).toBe("Ana");
		expect(disk.inserted()).toBe(1);
		disk.close();
		const reopened = sqlite_imperium_sync(file);
		const after_restart = (await (
			await handle_sync_http(
				new Request("http://local/sync/v1/mutaciones", {
					method: "POST",
					body: JSON.stringify(payload),
				}),
				"/sync/v1/mutaciones",
				reopened,
			)
		).json()) as { results: { status: string; row?: { id?: string; nombre?: string } }[] };
		expect(after_restart.results[0]?.status).toBe("applied");
		expect(after_restart.results[0]?.row?.nombre).toBe("Ana");
		expect((await reopened.find_id("contacto", "c-9"))?.nombre).toBe("Ana");
		expect(reopened.inserted()).toBe(0);
		reopened.close();
		unlinkSync(file);
		const other = sqlite_imperium_sync();
		const isolated = (await (
			await handle_sync_http(
				new Request("http://local/sync/v1/mutaciones", {
					method: "POST",
					body: JSON.stringify(payload),
				}),
				"/sync/v1/mutaciones",
				other,
			)
		).json()) as { results: { status: string }[] };
		expect(isolated.results[0]?.status).toBe("applied");
		const missing = await handle_sync_http(
			new Request("http://local/sync/v1/otra", { method: "POST", body: "{}" }),
			"/sync/v1/otra",
			store,
		);
		expect(missing.status).toBe(404);
		other.close();
	});

	test("pos-tickets incompleto no entra al store", async () => {
		const store = sqlite_imperium_sync();
		const incomplete = {
			server_id: "srv-http",
			mutations: [
				{
					server_id: "srv-http",
					client_id: "dev-1",
					seq: 1,
					name: "record.create",
					version: 1,
					payload: { resource: "pos-tickets", id: "t-1", fields: { nombre: "Ana" } },
				},
			],
		};
		await expect(
			handle_sync_http(
				new Request("http://local/sync/v1/mutaciones", {
					method: "POST",
					body: JSON.stringify(incomplete),
				}),
				"/sync/v1/mutaciones",
				store,
			),
		).rejects.toThrow(/ticket_sequence/);
		expect(await store.find_id("pos-tickets", "t-1")).toBeNull();
		store.close();
	});

	test("el ticket encolado es el cuerpo del alta y no se duplica", async () => {
		const storage = memory_storage();
		const ticket = {
			_id: "ticket-9",
			ticket_sequence: 9,
			pos_session: "507f1f77bcf86cd799439011",
			subtotal: 10.5,
			total_paid: 20,
			change: 9.5,
			items: [
				{
					item_id: { _id: "507f1f77bcf86cd799439012" },
					quantity: 2,
					total: 10.5,
					unit_price: 5.25,
					price_origin: "lista",
				},
			],
			withdrawal_signature: "",
			_rev: "1-abc",
			search_field: "no-va",
		};
		const online = pos_ticket_online_body(ticket);
		expect(online._rev).toBeUndefined();
		expect(online.search_field).toBeUndefined();
		expect((online.items as { item_id?: string }[])[0]?.item_id).toBe("507f1f77bcf86cd799439012");
		expect(queue_pos_ticket(storage, online)).toBe(1);
		const queued = pending_for_server(read_sync_device(storage), "local")[0];
		expect(queued?.payload.fields).toEqual(online);
		const store = sqlite_imperium_sync();
		const payload = {
			server_id: "local",
			mutations: pending_for_server(read_sync_device(storage), "local"),
		};
		const post = () =>
			handle_sync_http(
				new Request("http://local/sync/v1/mutaciones", {
					method: "POST",
					body: JSON.stringify(payload),
				}),
				"/sync/v1/mutaciones",
				store,
			);
		expect((await post()).status).toBe(200);
		expect((await post()).status).toBe(200);
		expect((await store.find_id("pos-tickets", "ticket-9"))?.ticket_sequence).toBe(9);
		expect((await store.find_id("pos-tickets", "ticket-9"))?.subtotal).toBe(10.5);
		expect((await store.find_id("pos-tickets", "ticket-9"))?.change).toBe(9.5);
		expect(store.inserted()).toBe(1);
		const edited = await handle_sync_http(
			new Request("http://local/sync/v1/mutaciones", {
				method: "POST",
				body: JSON.stringify({
					server_id: "local",
					mutations: [
						{
							server_id: "local",
							client_id: "device",
							seq: 2,
							name: "edit",
							version: 1,
							payload: {
								resource: "pos-tickets",
								id: "ticket-9",
								base: online,
								patch: { change: 4 },
							},
						},
					],
				}),
			}),
			"/sync/v1/mutaciones",
			store,
		);
		expect(edited.status).toBe(200);
		expect((await store.find_id("pos-tickets", "ticket-9"))?.change).toBe(4);
		expect(store.inserted()).toBe(1);
		store.close();
	});

	test("la lectura encolada es el cuerpo del formulario", async () => {
		const storage = memory_storage();
		const form = {
			_id: "lec-12",
			name: "Medidor norte",
			contrato: "507f1f77bcf86cd799439013",
			lectura_actual: 12,
		};
		const online = lectura_online_body(form);
		expect(online).toEqual(form);
		expect(capturar_lectura(storage, online)).toBe(1);
		const queued = pending_for_server(read_sync_device(storage), "local")[0];
		expect(queued?.payload.resource).toBe("lectura");
		expect(queued?.payload.fields).toEqual(online);
		const store = sqlite_imperium_sync();
		const payload = {
			server_id: "local",
			mutations: pending_for_server(read_sync_device(storage), "local"),
		};
		const post = () =>
			handle_sync_http(
				new Request("http://local/sync/v1/mutaciones", {
					method: "POST",
					body: JSON.stringify(payload),
				}),
				"/sync/v1/mutaciones",
				store,
			);
		expect((await post()).status).toBe(200);
		expect((await post()).status).toBe(200);
		const row = await store.find_id("lectura", "lec-12");
		expect(row?.name).toBe("Medidor norte");
		expect(row?.contrato).toBe("507f1f77bcf86cd799439013");
		expect(row?.lectura_actual).toBe(12);
		expect(store.inserted()).toBe(1);
		store.close();
	});
});

function memory_storage(): Storage {
	const values = new Map<string, string>();
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
		removeItem: (key) => {
			values.delete(key);
		},
		clear: () => values.clear(),
		key: (index) => [...values.keys()][index] ?? null,
		get length() {
			return values.size;
		},
	};
}

describe("colas pouch", () => {
	test("un alta de pedidos, POS, logística, GPS, infracción y agua queda en el motor", () => {
		const storage = memory_storage();
		expect(queue_pedido(storage, { _id: "p1", total: 1 })).toBe(1);
		expect(queue_pos_ticket(storage, { _id: "t1", total: 1 })).toBe(1);
		expect(queue_logistics(storage, { _id: "e1", total: 1 })).toBe(1);
		expect(queue_gps(storage, { _id: "g1", total: 1 })).toBe(1);
		expect(queue_violation(storage, { _id: "v1", total: 1 })).toBe(1);
		expect(queue_lectura(storage, { _id: "l1", m3: 2 })).toBe(1);
		expect(queue_pedido(storage, { _id: "p1", total: 1 })).toBe(0);
		expect(pending_queue_ids(memory_storage())).toEqual([]);
		expect(pending_queue_ids(storage)).toEqual(["p1", "t1", "e1", "g1", "v1", "l1"]);
	});

	test("el teléfono confirma puntos solo si la respuesta es el alta de esos puntos", () => {
		const puntos = [{ t: "2026-10-09T17:40:00.000Z", lat: 19.4326, lon: -99.1332 }];
		const body = gps_puntos_body("ruta-9", puntos);
		const ids = body.puntos.map((punto) => gps_point_id(body.ruta_id, punto));
		expect(confirm_gps_batch(body, ids)).toBe(true);
		expect(confirm_gps_batch({ distancia_m: 12, puntos: 1, nuevos: 1 }, ids)).toBe(true);
		expect(confirm_gps_batch({ results: [{ status: "applied" }], resource: "ruta-gps" }, ids)).toBe(false);
		expect(confirm_gps_batch({ status: "applied", resource: "ruta-gps" }, ids)).toBe(false);
		expect(confirm_gps_batch({ ok: true }, ids)).toBe(false);
		expect(confirm_gps_batch({ distancia_m: 12, puntos: 1, nuevos: 1 }, [])).toBe(false);
	});

	test("cada app reejecuta el mismo cuerpo que el alta en línea", async () => {
		for (const app of app_policies()) {
			for (const action of ["create", "edit", "primary"] as const) {
				const policy = action === "primary" ? app.primary.policy : app[action];
				const storage = memory_storage();
				const form = APP_CREATE_FORMS[app.slug] ?? { _id: `${app.slug}-sin-alta` };
				const queued = enqueue_app_alta(storage, { slug: app.slug, action, form });
				expect(queued.policy).toBe(policy);
				if (policy === "no" || policy === "diferido") {
					expect(queued.queued).toBe(0);
					expect(pending_queue_ids(storage)).toEqual([]);
					continue;
				}
				const body = online_alta_body(app.slug, form);
				expect(queued.body).toEqual(body);
				expect(queued.queued).toBe(1);
				const created = pending_for_server(read_sync_device(storage), "local")[0];
				expect(created?.payload.fields).toEqual(body);
				const store = sqlite_imperium_sync();
				const payload = { server_id: "local", mutations: [created] };
				const post = () =>
					handle_sync_http(
						new Request("http://local/sync/v1/mutaciones", {
							method: "POST",
							body: JSON.stringify(payload),
						}),
						"/sync/v1/mutaciones",
						store,
					);
				expect((await post()).status).toBe(200);
				expect((await post()).status).toBe(200);
				const id = String(form._id);
				const row = await store.find_id(queued.resource!, id);
				for (const [key, value] of Object.entries(body)) {
					if (key === "_id") continue;
					expect(row?.[key]).toEqual(value);
				}
				expect(store.inserted()).toBe(1);
				if (action === "edit") {
					const patch = APP_EDIT_PATCH[app.slug];
					expect(patch).toBeTruthy();
					const edited = online_alta_body(app.slug, { ...form, ...patch });
					expect(enqueue_alta_edit(storage, queued.resource!, id, body, patch!)).toBe(1);
					const edit = pending_for_server(read_sync_device(storage), "local").find(
						(item) => item.name === "edit",
					);
					expect(edit?.payload.patch).toEqual(patch);
					const edited_post = await handle_sync_http(
						new Request("http://local/sync/v1/mutaciones", {
							method: "POST",
							body: JSON.stringify({ server_id: "local", mutations: [edit] }),
						}),
						"/sync/v1/mutaciones",
						store,
					);
					expect(edited_post.status).toBe(200);
					const after = await store.find_id(queued.resource!, id);
					for (const [key, value] of Object.entries(edited)) {
						if (key === "_id") continue;
						expect(after?.[key]).toEqual(value);
					}
					expect(store.inserted()).toBe(1);
				}
				store.close();
			}
		}
	});

	test("la cédula entra por remember_violation_outbox y se lee de la cola", () => {
		const storage = memory_storage();
		remember_violation_outbox(storage, {
			_id: "offline-1",
			name: "Juan",
		} as Parameters<typeof remember_violation_outbox>[1]);
		expect(pending_queue_ids(storage)).toContain("offline-1");
	});
});
