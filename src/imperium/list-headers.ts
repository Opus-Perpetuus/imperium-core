/**
 * Encabezados y tipos de columna en español para listas que hoy salen con el
 * nombre técnico de la columna (`allow create`, `positional code`, fechas ISO).
 * Solo decora `tipo_de_instancia`: no cambia filas, esquema ni datos.
 */
type InstanceType = Record<string, { nombre_encabezado: string; tipo: string }>;

const SI_NO = 'Boolean';
const FECHA = 'Date';

type ColumnSpec = { label?: string; tipo?: string };

const PERMISOS: Record<string, ColumnSpec> = {
	allow_create: { label: 'Crear', tipo: SI_NO },
	allow_read: { label: 'Leer', tipo: SI_NO },
	allow_update: { label: 'Editar', tipo: SI_NO },
	allow_delete: { label: 'Eliminar', tipo: SI_NO },
	model_id: { label: 'Modelo' },
	group_id: { label: 'Grupo' },
};

const COLUMNS: Record<string, Record<string, ColumnSpec>> = {
	'access-rights': PERMISOS,
	'record-rules': { ...PERMISOS, domain: { label: 'Dominio' } },
	pedidos: {
		folio_interno: { label: 'Folio interno' },
		fecha: { label: 'Fecha', tipo: FECHA },
		init_time: { label: 'Hora de inicio', tipo: FECHA },
		end_time: { label: 'Hora de fin', tipo: FECHA },
		assigned_employee: { label: 'Empleado asignado' },
		invoice_request_id: { label: 'Id de solicitud de factura' },
		invoice_request_name: { label: 'Solicitud de factura' },
		invoice_request_estado: { label: 'Estado de la solicitud de factura' },
		invoice_request_monto_total: { label: 'Monto de la solicitud de factura' },
		invoice_request_actualizado: { label: 'Solicitud de factura actualizada', tipo: FECHA },
	},
	products: {
		positional_code: { label: 'Código de ubicación' },
		codigos_proveedor: { label: 'Códigos de proveedor' },
	},
	'purchase-order': {
		proveedor_nombre: { label: 'Proveedor' },
		proveedor_id: { label: 'Id de proveedor' },
	},
	'attachment-management': {
		name_stored: { label: 'Archivo guardado' },
		mimetype: { label: 'Tipo de archivo' },
		created_by_id: { label: 'Creado por' },
		related_model: { label: 'Modelo relacionado' },
		related_record_id: { label: 'Id del registro relacionado' },
		field: { label: 'Campo' },
		size_in_kb: { label: 'Tamaño (KB)' },
		file_ext: { label: 'Extensión' },
		index_if_is_array: { label: 'Posición' },
		inside_array: { label: 'Dentro de una lista', tipo: SI_NO },
	},
	'menu-management': {
		icon: { label: 'Ícono' },
		path: { label: 'Ruta' },
		parent_id: { label: 'Menú padre' },
		order: { label: 'Orden' },
		model: { label: 'Modelo' },
	},
	'epson-ticket-template': {
		template_key: { label: 'Clave de plantilla' },
		content: { label: 'Contenido' },
		line_width: { label: 'Ancho de línea' },
		render_target: { label: 'Destino de impresión' },
		dpmm: { label: 'Puntos por mm' },
		label_size_mm_x: { label: 'Ancho de etiqueta (mm)' },
		label_size_mm_y: { label: 'Alto de etiqueta (mm)' },
	},
	'user-pin': {
		document_id: { label: 'Id del documento' },
		document_collection: { label: 'Colección' },
		document_model: { label: 'Modelo' },
		document_label: { label: 'Documento' },
		is_global: { label: 'Global', tipo: SI_NO },
		pin_type: { label: 'Tipo de PIN' },
		pin_length: { label: 'Longitud del PIN' },
		auto_generated: { label: 'Generado automáticamente', tipo: SI_NO },
		method: { label: 'Método' },
		path: { label: 'Ruta' },
		route_key: { label: 'Clave de ruta' },
		label: { label: 'Etiqueta' },
		assigned_users: { label: 'Usuarios asignados' },
	},
	'auto-increment-control': {
		model_name: { label: 'Modelo' },
		collection: { label: 'Colección' },
		increment_field: { label: 'Campo consecutivo' },
		index_name: { label: 'Índice' },
		type: { label: 'Tipo' },
		custom_pattern: { label: 'Patrón' },
		current_sequence: { label: 'Consecutivo actual' },
		current_real_value: { label: 'Valor actual' },
	},
};

/** Fechas de auditoría: el núcleo las guarda como texto ISO. */
const AUDIT_DATES = new Set(['created_at', 'updated_at', 'createdAt', 'updatedAt']);
const AUDIT_LABELS: Record<string, string> = {
	created_at: 'Fecha de creación',
	createdAt: 'Fecha de creación',
	updated_at: 'Fecha de actualización',
	updatedAt: 'Fecha de actualización',
};

/** El encabezado por defecto es la clave con `_` → espacio; solo ese se reemplaza. */
function is_default_header(key: string, header: string) {
	return header === key.replace(/_/g, ' ');
}

export function decorate_list_instance_type(resource: string, instance: InstanceType): InstanceType {
	const specs = COLUMNS[resource] ?? {};
	const out: InstanceType = {};
	for (const [key, value] of Object.entries(instance)) {
		const spec: ColumnSpec = specs[key] ??
			(AUDIT_DATES.has(key) ? { label: AUDIT_LABELS[key], tipo: FECHA } : {});
		const keep_header = !is_default_header(key, value.nombre_encabezado);
		out[key] = {
			nombre_encabezado:
				keep_header || !spec.label ? value.nombre_encabezado : spec.label,
			tipo: value.tipo === 'string' && spec.tipo ? spec.tipo : value.tipo,
		};
	}
	return out;
}
