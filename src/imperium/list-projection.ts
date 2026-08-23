/**
 * Proyección de listados = `campos_para_proyectar` / tipo del `__read` original.
 * El schema SQL de los súbditos sube campos anidados a columnas; sin esto
 * la lista Angular muestra partidas, widgets y eventos como columnas.
 */
import { type ImperiumDoc } from './envelope.ts';

const RESOURCE_ALIASES: Record<string, string> = {
	proyectos: 'planeacion-proyectos',
	'mis-tareas': 'planeacion-mis-tareas',
	'proyectos-task': 'planeacion-proyectos-task',
};

type ListProjection = {
	rows: readonly string[];
	tipo?: readonly string[];
};

const LIST_PROJECTIONS: Record<string, ListProjection> = {
	products: {
		rows: [
			'_id',
			'name',
			'description',
			'existencia',
			'existenciaApartada',
			'existenciaDisponible',
			'costoVenta',
			'costoCompraPromedio',
			'ultimoCostoCompra',
			'fechaUltimaCompra',
			'stockMaximo',
			'stockMinimo',
			'codigo',
			'positional_code',
			'unidad',
			'puedoVenderlo',
			'puedoComprarlo',
			'image',
			'codigos_proveedor',
			'clave_prod_serv',
			'objeto_imp_default',
			'ubicacion_preferida',
			'ubicacion_preferida_codigo',
		],
	},
	'purchase-order': {
		rows: [
			'_id',
			'folio_interno',
			'name',
			'description',
			'proveedor_nombre',
			'proveedor_id',
			'estado',
			'tipo_origen',
			'total_cantidad',
			'total_recibido',
			'subtotal',
			'fecha_aprobacion',
			'fecha_confirmacion',
			'is_active',
		],
	},
	branchoffice: {
		rows: ['_id', 'name', 'location', 'image', 'description', 'is_active'],
	},
	employee: {
		rows: [
			'_id',
			'name',
			'description',
			'puesto',
			'department',
			'branch_office',
			'num_empleado',
			'rfc',
			'curp',
			'is_active',
		],
	},
	reports: {
		rows: [
			'_id',
			'name',
			'description',
			'page_size',
			'pdf_setting',
			'related_model',
			'html_content',
			'generated_report_name',
			'excel_format',
			'excel_sheet_name',
			'is_active',
			'_ref',
		],
		tipo: [
			'name',
			'description',
			'page_size',
			'pdf_setting',
			'related_model',
			'generated_report_name',
			'is_active',
		],
	},
	'delivery-package': {
		rows: [
			'_id',
			'name',
			'codigo_bulto',
			'numero_bulto',
			'pedido_folio',
			'pedido_folio_interno',
			'pedido_contacto_nombre',
			'delivery_route_nombre',
			'vehicle_nombre',
			'peso_kg',
			'contenido_resumen',
			'pedido_total_bultos',
			'estado',
			'is_active',
		],
	},
	'delivery-route': {
		rows: ['_id', 'name', 'description', 'vehicle_name', 'is_active'],
	},
	'pos-session': {
		rows: [
			'_id',
			'consecutivo',
			'diferencia_de_ultimo_cierre',
			'razon_de_diferencia_con_ultimo_cierre',
			'name',
			'description',
			'is_active',
			'status',
			'opening_date',
			'closing_date',
			'cash_register_opening_money',
			'on_use',
			'usage_history',
			'created_by',
			'cashier',
			'branch_office',
		],
	},
	'citizen-report': {
		rows: [
			'_id',
			'name',
			'is_active',
			'citizen_name',
			'citizen_phone',
			'citizen_street',
			'building_number_external',
			'building_number_internal',
			'neighborhood',
			'borough',
			'report_description',
			'citizen_report_problem',
			'employee_taken_the_report',
			'assinged_to',
			'priority',
			'status',
			'department',
			'cuadrilla',
			'jefe_de_cuadrilla',
			'reporting_medium',
			'createdAt',
		],
	},
	asociaciones: {
		rows: ['_id', 'name', 'telefono', 'correo', 'ciudad', 'localidad', 'is_active'],
	},
	'registro-incidencias': {
		rows: [
			'_id',
			'name',
			'alumno_id',
			'grupo_id',
			'registro_asistencia_id',
			'lista_asistencia_id',
			'materia_id',
			'grado_escolar_id',
			'escuela_id',
			'tipo',
			'justificada',
			'evidencia',
			'fecha_asistencia',
			'is_active',
		],
	},
	'medical-file': {
		rows: [
			'_id',
			'paciente_id',
			'numero_expediente',
			'nombre_paciente',
			'fecha_consulta',
			'hora_consulta',
			'status',
			'is_active',
		],
	},
	'ticketing-system-turn': {
		rows: [
			'_id',
			'name',
			'description',
			'movements',
			'customer_type',
			'assigned_box',
			'services',
			'status',
			'time',
			'createdAt',
		],
	},
	'planeacion-proyectos': {
		rows: [
			'_id',
			'name',
			'description',
			'priority',
			'start_date',
			'due_date',
			'owner_user',
			'is_active',
		],
	},
	'planeacion-mis-tareas': {
		rows: [
			'_id',
			'name',
			'description',
			'state',
			'priority',
			'due_date',
			'parent_task',
			'owner_user',
			'is_active',
		],
	},
	'planeacion-proyectos-task': {
		rows: [
			'_id',
			'name',
			'description',
			'status',
			'priority',
			'due_date',
			'project_id',
			'parent_task_id',
			'is_active',
		],
	},
	payments: {
		rows: ['_id', 'name', 'is_active', 'service_slug', 'amount', 'status', 'description'],
	},
	'invoice-request': {
		rows: [
			'_id',
			'name',
			'pedido_folio',
			'contacto_nombre',
			'estado',
			'monto_total',
			'monto_umbral',
			'autorizado_cobranza',
			'requiere_facturacion_dividida',
			'cfdi_document_id',
			'cfdi_document_status',
			'cfdi_document_name',
		],
	},
	'cfdi-document': {
		rows: [
			'_id',
			'name',
			'is_active',
			'status',
			'perfil_emision',
			'flow_direction',
			'receptor_rfc',
			'receptor_nombre',
			'emisor_rfc',
			'emisor_nombre',
			'total',
			'uuid',
			'purchase_order_nombre',
			'purchase_order_id',
		],
	},
	'dynamic-dashboard': {
		rows: ['_id', 'name', 'description', 'is_global', 'is_active'],
	},
	vehicle: {
		rows: [
			'_id',
			'name',
			'placas',
			'numero_economico',
			'marca',
			'modelo',
			'tipo_unidad',
			'estado_operativo',
			'chofer',
			'chofer_nombre',
			'capacidad_carga_kg',
			'anio',
			'is_active',
			'foto',
		],
	},
	'physical-device': {
		rows: [
			'_id',
			'name',
			'hostname',
			'model',
			'serial',
			'os_platform',
			'last_user_name',
			'last_seen',
			'is_active',
		],
	},
	'view-config-preset': {
		rows: ['_id', 'name', 'description', 'scope', 'is_template', 'force_locked', 'is_active'],
	},
};

function projection_for(resource: string): ListProjection | undefined {
	return LIST_PROJECTIONS[resource] ?? LIST_PROJECTIONS[RESOURCE_ALIASES[resource] ?? ''];
}

function instance_map(
	keys: readonly string[],
): Record<string, { nombre_encabezado: string; tipo: string }> {
	const out: Record<string, { nombre_encabezado: string; tipo: string }> = {};
	for (const key of keys) {
		out[key] = { nombre_encabezado: key.replace(/_/g, ' '), tipo: 'string' };
	}
	return out;
}

export function list_instance_type(
	resource: string,
): Record<string, { nombre_encabezado: string; tipo: string }> | null {
	const spec = projection_for(resource);
	if (!spec) return null;
	return instance_map(spec.tipo ?? spec.rows);
}

export function project_list_docs(resource: string, rows: ImperiumDoc[]): ImperiumDoc[] {
	const spec = projection_for(resource);
	if (!spec) return rows;
	const allow = new Set<string>(spec.rows);
	for (const key of spec.rows) allow.add(`${key}_id`);
	return rows.map((row) => {
		const out: ImperiumDoc = {};
		for (const key of allow) {
			if (row[key] !== undefined) out[key] = row[key];
		}
		if (out._id == null && row._id != null) out._id = row._id;
		return out;
	});
}
