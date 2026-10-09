import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defer_mutation, type LocalSession } from "./device";
import { type Authority, type OfflinePolicy, create_authority } from "./types";

export type CoreFunctionPolicy = {
	id: string;
	policy: OfflinePolicy;
	explanation: string;
};

export type AppActionPolicy = {
	slug: string;
	create: OfflinePolicy;
	edit: OfflinePolicy;
	primary: { name: string; policy: OfflinePolicy };
	explanation: string;
};

const NO_SERVER =
	"Esta acción requiere servidor. Sin conexión queda deshabilitada.";
const DEFER =
	"Quedó registrado y se ejecutará al reconectar.";

export const CORE_FUNCTION_POLICIES: CoreFunctionPolicy[] = [
	{ id: "consultar", policy: "si", explanation: "Lee la base local al corte." },
	{ id: "crear_catalogo", policy: "si", explanation: "Alta local por campo." },
	{ id: "editar_catalogo", policy: "si", explanation: "Edición local por campo." },
	{ id: "pedidos", policy: "provisional", explanation: "El servidor confirma el folio." },
	{ id: "pos", policy: "provisional", explanation: "Ticket de serie de la terminal." },
	{ id: "cobro_efectivo", policy: "provisional", explanation: "El efectivo se confirma al sincronizar." },
	{ id: "compras", policy: "provisional", explanation: "La compra queda provisional." },
	{ id: "recepciones", policy: "provisional", explanation: "La recepción queda provisional." },
	{ id: "inventario", policy: "provisional", explanation: "Movimiento por delta, con cuota." },
	{ id: "logistica", policy: "provisional", explanation: "El evento se confirma al sincronizar." },
	{ id: "infracciones", policy: "provisional", explanation: "La cédula sube al reconectar." },
	{ id: "gps", policy: "provisional", explanation: "El punto sube al reconectar." },
	{ id: "lecturas_agua", policy: "provisional", explanation: "La lectura queda provisional." },
	{ id: "aprobaciones", policy: "provisional", explanation: "Si el documento cambió, vuelve a la bandeja." },
	{ id: "timbrado", policy: "diferido", explanation: DEFER },
	{ id: "cancelacion_cfdi", policy: "no", explanation: "Cancelar un CFDI requiere servidor." },
	{ id: "correo", policy: "diferido", explanation: DEFER },
	{ id: "pdf", policy: "diferido", explanation: "Vista previa local; el PDF oficial espera al servidor." },
	{ id: "adjuntos", policy: "si", explanation: "La captura queda en el dispositivo." },
	{ id: "pago_tarjeta", policy: "no", explanation: "El pago con tarjeta no se guarda para reenviar." },
	{ id: "login", policy: "no", explanation: "Entrar exige servidor. La sesión guardada se abre con PIN." },
	{ id: "usuarios", policy: "no", explanation: NO_SERVER },
	{ id: "permisos", policy: "no", explanation: NO_SERVER },
	{ id: "configuracion", policy: "no", explanation: NO_SERVER },
	{ id: "portal", policy: "no", explanation: "El portal público es para terceros en línea." },
	{ id: "turnos", policy: "no", explanation: "Los turnos en tiempo real requieren servidor." },
	{ id: "chat", policy: "no", explanation: "El chat entre usuarios requiere servidor." },
];

const APP_OVERRIDES: Record<
	string,
	Pick<AppActionPolicy, "create" | "edit" | "primary" | "explanation">
> = {
	almacen: {
		create: "provisional",
		edit: "provisional",
		primary: { name: "recibir", policy: "provisional" },
		explanation: "La recepción de almacén queda provisional.",
	},
	"configuraciones-de-vista": {
		create: "no",
		edit: "no",
		primary: { name: "publicar_vista", policy: "no" },
		explanation: "Publicar una vista requiere servidor.",
	},
	configuracion: {
		create: "no",
		edit: "no",
		primary: { name: "guardar_parametro", policy: "no" },
		explanation: NO_SERVER,
	},
	"control-hospitalario": {
		create: "si",
		edit: "si",
		primary: { name: "registrar_nota", policy: "si" },
		explanation: "La nota clínica se guarda en el dispositivo.",
	},
	"control-emergencias": {
		create: "provisional",
		edit: "si",
		primary: { name: "despachar", policy: "provisional" },
		explanation: "El despacho queda provisional.",
	},
	"control-escolar": {
		create: "si",
		edit: "si",
		primary: { name: "pasar_lista", policy: "si" },
		explanation: "La lista se guarda en el dispositivo.",
	},
	"control-municipal": {
		create: "provisional",
		edit: "si",
		primary: { name: "levantar_infraccion", policy: "provisional" },
		explanation: "La cédula queda provisional.",
	},
	"dispositivos-fisicos": {
		create: "diferido",
		edit: "si",
		primary: { name: "imprimir", policy: "diferido" },
		explanation: "La impresión oficial espera al dispositivo en línea.",
	},
	"facturacion-electronica": {
		create: "diferido",
		edit: "diferido",
		primary: { name: "timbrar", policy: "diferido" },
		explanation: DEFER,
	},
	logistica: {
		create: "provisional",
		edit: "provisional",
		primary: { name: "entregar", policy: "provisional" },
		explanation: "La entrega queda provisional.",
	},
	pos: {
		create: "provisional",
		edit: "provisional",
		primary: { name: "cobrar_efectivo", policy: "provisional" },
		explanation: "El cobro en efectivo queda provisional.",
	},
	pagos: {
		create: "provisional",
		edit: "no",
		primary: { name: "cobrar_tarjeta", policy: "no" },
		explanation: "El pago con tarjeta no se reenvía.",
	},
	rh: {
		create: "si",
		edit: "si",
		primary: { name: "registrar_asistencia", policy: "si" },
		explanation: "La asistencia se guarda en el dispositivo.",
	},
	reportes: {
		create: "diferido",
		edit: "si",
		primary: { name: "generar_pdf", policy: "diferido" },
		explanation: "El PDF oficial espera al servidor.",
	},
	planeacion: {
		create: "si",
		edit: "si",
		primary: { name: "programar", policy: "si" },
		explanation: "La planeación se guarda en el dispositivo.",
	},
	"tableros-dinamicos": {
		create: "si",
		edit: "si",
		primary: { name: "consultar", policy: "si" },
		explanation: "El tablero lee el corte local.",
	},
	turnos: {
		create: "no",
		edit: "no",
		primary: { name: "llamar_turno", policy: "no" },
		explanation: "Llamar un turno requiere servidor.",
	},
	vehiculos: {
		create: "si",
		edit: "si",
		primary: { name: "registrar_salida", policy: "provisional" },
		explanation: "La salida del vehículo queda provisional.",
	},
	ventas: {
		create: "provisional",
		edit: "si",
		primary: { name: "confirmar_pedido", policy: "provisional" },
		explanation: "El pedido queda provisional.",
	},
	tienda: {
		create: "no",
		edit: "no",
		primary: { name: "pagar_en_linea", policy: "no" },
		explanation: "La tienda pública requiere servidor.",
	},
	"database-manager": {
		create: "no",
		edit: "no",
		primary: { name: "ejecutar_sql", policy: "no" },
		explanation: "Administrar la base requiere servidor.",
	},
	herramientas: {
		create: "si",
		edit: "si",
		primary: { name: "consultar", policy: "si" },
		explanation: "La consulta usa el corte local.",
	},
	predial: {
		create: "provisional",
		edit: "provisional",
		primary: { name: "registrar_predio", policy: "provisional" },
		explanation: "El predio queda provisional hasta que el servidor lo confirme.",
	},
	ingresos: {
		create: "provisional",
		edit: "no",
		primary: { name: "registrar_ingreso", policy: "provisional" },
		explanation: "El ingreso en efectivo queda provisional. La tarjeta no se reenvía.",
	},
	presupuesto: {
		create: "no",
		edit: "no",
		primary: { name: "autorizar", policy: "no" },
		explanation: "Autorizar una partida requiere servidor.",
	},
	tramites: {
		create: "provisional",
		edit: "si",
		primary: { name: "recibir_solicitud", policy: "provisional" },
		explanation: "La solicitud queda provisional hasta que el servidor la reciba.",
	},
};

export function catalog_slugs(): string[] {
	const here = dirname(fileURLToPath(import.meta.url));
	const catalog_path = join(here, "../../../../catalog.json");
	const catalog = JSON.parse(readFileSync(catalog_path, "utf8")) as {
		subjects?: { slug?: string }[];
	};
	return (catalog.subjects ?? [])
		.map((subject) => String(subject.slug ?? "").trim())
		.filter((slug) => slug.length > 0);
}

export function app_policies(): AppActionPolicy[] {
	return catalog_slugs().map((slug) => {
		const override = APP_OVERRIDES[slug];
		if (!override) {
			throw new Error(`La app ${slug} no tiene política offline`);
		}
		return { slug, ...override };
	});
}

export function policy_of(id: string): CoreFunctionPolicy | undefined {
	return CORE_FUNCTION_POLICIES.find((item) => item.id === id);
}

export type OfflineActionResult = {
	policy: OfflinePolicy;
	explanation: string;
	refused?: boolean;
	deferred?: boolean;
};

export function run_offline_action(input: {
	device: LocalSession;
	authority: Authority;
	online: Authority;
	app: string;
	action: "create" | "edit" | "primary";
	record_id: string;
}): OfflineActionResult {
	const app = app_policies().find((item) => item.slug === input.app);
	if (!app) throw new Error(`App desconocida: ${input.app}`);
	const policy = input.action === "primary" ? app.primary.policy : app[input.action];
	const explanation = app.explanation;
	if (policy === "no") {
		return { policy, explanation, refused: true };
	}
	const accion = input.action === "primary" ? app.primary.name : input.action;
	if (policy === "diferido") {
		const stamp = accion === "timbrar";
		defer_mutation(input.device, {
			server_id: input.device.server_id,
			client_id: input.device.client_id,
			seq: input.device.next_seq,
			name: stamp ? "cfdi.enqueue" : accion,
			version: 1,
			payload: stamp
				? {
						id: `${input.app}-${input.record_id}`,
						sold_at: Date.parse("2026-10-09T12:00:00Z"),
						total: 0,
						accion,
					}
				: { accion, id: input.record_id },
		});
		input.device.next_seq += 1;
		return { policy, explanation, deferred: true };
	}
	return { policy, explanation };
}

export function refuse_core_call(id: string): OfflineActionResult {
	const item = policy_of(id);
	if (!item) throw new Error(`Función desconocida: ${id}`);
	if (item.policy !== "no") {
		throw new Error(`${id} no es una función deshabilitada`);
	}
	return { policy: item.policy, explanation: item.explanation, refused: true };
}

export function empty_pair(): { device_authority: Authority; online: Authority } {
	return { device_authority: create_authority(), online: create_authority() };
}
