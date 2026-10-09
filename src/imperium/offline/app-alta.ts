import { crud_online_document } from "../../../../../frontend/src/app/services/crud-form-data.utils.ts";
import { app_policies } from "./policy";
import { pos_ticket_online_body } from "./pos-ticket-body";
import { enqueue_alta_document } from "./pouch-bridge";
import type { OfflinePolicy } from "./types";

export const APP_ALTA_RESOURCE: Record<string, string> = {
	almacen: "inventory-reception",
	"control-hospitalario": "medical-file",
	"control-emergencias": "citizen-report",
	"control-escolar": "lista-asistencia",
	"control-municipal": "violation",
	"dispositivos-fisicos": "zpl-management",
	logistica: "delivery-package",
	pos: "pos-tickets",
	pagos: "payments",
	rh: "labor-schedule",
	reportes: "reports",
	planeacion: "planeacion-proyectos",
	"tableros-dinamicos": "dynamic-dashboard",
	vehiculos: "vehicle",
	ventas: "pedidos",
	herramientas: "herr-tablas",
	predial: "predio",
	ingresos: "ingreso",
	tramites: "tramite",
};

export const APP_CREATE_FORMS: Record<string, Record<string, unknown>> = {
	almacen: {
		_id: "recepcion-12",
		name: "Recepción de 12 cajas",
		estado: "pendiente",
		purchase_order: "507f1f77bcf86cd799439011",
	},
	"control-hospitalario": {
		_id: "nota-14",
		paciente_id: "507f1f77bcf86cd799439021",
		numero_expediente: "EXP-2026-014",
		nombre_paciente: "Ana López",
		fecha_consulta: "2026-10-09",
		hora_consulta: "09:30",
	},
	"control-emergencias": {
		_id: "reporte-3",
		citizen_name: "Luis Hernández",
		citizen_email: "luis.hernandez@correo.example",
		citizen_phone: "3312345678",
		citizen_street: "Calle Morelos 18",
		report_description: "Fuga de agua en la banqueta",
		priority: "ALTA",
		status: "pendiente",
		citizen_report_problem: "507f1f77bcf86cd799439031",
		reporting_medium: "507f1f77bcf86cd799439032",
	},
	"control-escolar": {
		_id: "lista-2",
		name: "Pase del grupo 2",
		registro_asistencia_id: "507f1f77bcf86cd799439041",
		alumno_id: "507f1f77bcf86cd799439042",
		grupo_id: "507f1f77bcf86cd799439043",
		alumno_nombre_snapshot: "María Soto",
	},
	"control-municipal": {
		_id: "cedula-7",
		name: "Cédula de tránsito 7",
		vehicle_type_id: "507f1f77bcf86cd799439051",
		vehicle_brand_id: "507f1f77bcf86cd799439052",
		color: "blanco",
		police_officer_id: "507f1f77bcf86cd799439053",
		city_zone_id: "507f1f77bcf86cd799439054",
		img_signature_police_officer: "firma-oficial-7",
	},
	"dispositivos-fisicos": {
		_id: "etiqueta-4",
		name: "Etiqueta de anaquel 4",
	},
	logistica: {
		_id: "bulto-3",
		name: "Bulto 3 del pedido 18",
		pedido: "507f1f77bcf86cd799439061",
		pedido_folio: "PED-18",
		codigo_bulto: "BUL-18-3",
		numero_bulto: 3,
		estado: "pendiente",
	},
	pos: {
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
	},
	pagos: {
		_id: "cobro-40",
		name: "Cobro en efectivo de 40",
		amount: 40,
		service_slug: "mostrador",
	},
	rh: {
		_id: "turno-matutino",
		name: "Turno matutino de caja",
		employee: "507f1f77bcf86cd799439071",
	},
	reportes: {
		_id: "reporte-ventas",
		name: "Ventas del día",
		related_model: "pedidos",
		html_content: "<p>Ventas del día</p>",
	},
	planeacion: {
		_id: "plan-octubre",
		name: "Plan de octubre",
	},
	"tableros-dinamicos": {
		_id: "tablero-caja",
		name: "Tablero de caja",
	},
	vehiculos: {
		_id: "unidad-4",
		name: "Unidad 4",
		placas: "ABC-123-D",
		tipo_unidad: "pickup",
		estado_operativo: "disponible",
	},
	ventas: {
		_id: "pedido-18",
		name: "Pedido 18 de mostrador",
	},
	herramientas: {
		_id: "tabla-rutas",
		name: "Tabla de rutas",
	},
	predial: {
		_id: "predio-22",
		name: "Predio 22",
	},
	ingresos: {
		_id: "ingreso-40",
		name: "Ingreso en efectivo de 40",
		amount: 40,
	},
	tramites: {
		_id: "solicitud-5",
		name: "Solicitud de constancia",
	},
};

export const APP_EDIT_PATCH: Record<string, Record<string, unknown>> = {
	almacen: { name: "Recepción de 18 cajas" },
	"control-hospitalario": { nombre_paciente: "Ana López Ruiz" },
	"control-emergencias": { report_description: "Fuga de agua ya contenida" },
	"control-escolar": { alumno_nombre_snapshot: "María Soto Díaz" },
	"control-municipal": { color: "gris" },
	"dispositivos-fisicos": { name: "Etiqueta de anaquel 4 corregida" },
	logistica: { codigo_bulto: "BUL-18-3B" },
	pos: { change: 4 },
	rh: { name: "Turno vespertino de caja" },
	reportes: { html_content: "<p>Ventas del día, corte 18:00</p>" },
	planeacion: { name: "Plan de octubre revisado" },
	"tableros-dinamicos": { name: "Tablero de caja del mes" },
	vehiculos: { placas: "XYZ-987-E" },
	ventas: { name: "Pedido 18 surtido" },
	herramientas: { name: "Tabla de rutas del día" },
	predial: { name: "Predio 22 actualizado" },
	tramites: { name: "Solicitud de constancia recibida" },
};

export function app_alta_resource(slug: string): string {
	const resource = APP_ALTA_RESOURCE[slug];
	if (!resource) throw new Error(`La app ${slug} no tiene alta en línea`);
	return resource;
}

export function online_alta_body(slug: string, form: Record<string, unknown>): Record<string, unknown> {
	if (slug === "pos") return pos_ticket_online_body(form);
	return crud_online_document(form);
}

export function enqueue_app_alta(
	storage: Storage,
	input: { slug: string; action: "create" | "edit" | "primary"; form: Record<string, unknown> },
): { policy: OfflinePolicy; queued: number; body?: Record<string, unknown>; resource?: string } {
	const app = app_policies().find((item) => item.slug === input.slug);
	if (!app) throw new Error(`App desconocida: ${input.slug}`);
	const policy = input.action === "primary" ? app.primary.policy : app[input.action];
	if (policy === "no" || policy === "diferido") return { policy, queued: 0 };
	const body = online_alta_body(input.slug, input.form);
	const resource = app_alta_resource(input.slug);
	const id = String(input.form._id ?? "").trim();
	if (!id) throw new Error("El alta no tiene id");
	return { policy, queued: enqueue_alta_document(storage, resource, id, body), body, resource };
}
