import { as_array, as_object } from './envelope.ts';

export type WidgetFamily = 'kpi' | 'progress' | 'chart' | 'table';

export type WidgetKind = {
	widget_type: string;
	family: WidgetFamily;
	aggregations: readonly string[];
	max_rows: number;
};

export type WidgetSpecCheck =
	| { ok: true; spec: Record<string, unknown> }
	| { ok: false; errors: string[] };

const SCALAR_AGGREGATIONS = ['count', 'sum', 'avg', 'min', 'max'] as const;
const CHART_AGGREGATIONS = ['count', 'sum'] as const;
const AGGREGATE_MAX_ROWS = 20000;
const FILTER_OPS = new Set(['eq', 'lt', 'lte', 'gt', 'gte']);
const BLOCKED_PATH_SEGMENTS = new Set(['password', 'permissions']);

const kinds = new Map<string, WidgetKind>();

export function register_widget_kind(kind: WidgetKind) {
	kinds.set(kind.widget_type, kind);
}

export function widget_kinds(): WidgetKind[] {
	return [...kinds.values()];
}

export function get_widget_kind(widget_type: string): WidgetKind | undefined {
	return kinds.get(widget_type);
}

export function is_blocked_path(path: string) {
	return String(path ?? '')
		.split('.')
		.some(
			(segment) =>
				BLOCKED_PATH_SEGMENTS.has(segment.toLowerCase()) || segment.startsWith('__'),
		);
}

register_widget_kind({ widget_type: 'kpi', family: 'kpi', aggregations: SCALAR_AGGREGATIONS, max_rows: AGGREGATE_MAX_ROWS });
register_widget_kind({ widget_type: 'progress', family: 'progress', aggregations: SCALAR_AGGREGATIONS, max_rows: AGGREGATE_MAX_ROWS });
register_widget_kind({ widget_type: 'chart-pie', family: 'chart', aggregations: CHART_AGGREGATIONS, max_rows: AGGREGATE_MAX_ROWS });
register_widget_kind({ widget_type: 'chart-line', family: 'chart', aggregations: CHART_AGGREGATIONS, max_rows: AGGREGATE_MAX_ROWS });
register_widget_kind({ widget_type: 'chart-bar', family: 'chart', aggregations: CHART_AGGREGATIONS, max_rows: AGGREGATE_MAX_ROWS });
register_widget_kind({ widget_type: 'table', family: 'table', aggregations: ['count'], max_rows: 100 });

function model_token(value: unknown) {
	return String(value ?? '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

export function validate_widget_spec(raw: unknown, catalog: unknown[]): WidgetSpecCheck {
	const spec = { ...as_object(raw) };
	const errors: string[] = [];
	const widget_type = String(spec.widget_type ?? '');
	const kind = get_widget_kind(widget_type);
	if (!kind) errors.push(`Tipo de widget no soportado: '${widget_type}'.`);
	if (spec.domain != null) errors.push("El asistente no puede enviar 'domain'.");
	const model_id = String(spec.model_id ?? '');
	const entry = catalog
		.map(as_object)
		.find((item) => model_token(item.model_id) === model_token(model_id) && model_id !== '');
	if (!entry) {
		errors.push(`El modelo '${model_id}' no está en tu catálogo.`);
		return { ok: false, errors };
	}
	const known = new Set(as_array(entry.fields).map((field) => String(as_object(field).path ?? '')));
	const aggregation = as_object(spec.aggregation);
	const op = String(aggregation.op ?? '');
	const used: string[] = [
		...as_array(spec.fields).map(String),
		String(spec.group_by ?? ''),
		String(aggregation.field ?? ''),
		String(spec.date_field ?? ''),
		String(spec.sort ?? '').split(':')[0] ?? '',
	];
	for (const filter of as_array(spec.filters)) {
		const row = as_object(filter);
		used.push(String(row.field ?? ''));
		const filter_op = String(row.op ?? 'eq');
		if (!FILTER_OPS.has(filter_op)) errors.push(`Operador de filtro no permitido: '${filter_op}'.`);
	}
	for (const field of used.filter(Boolean)) {
		if (is_blocked_path(field) || !known.has(field)) {
			errors.push(`El campo '${field}' no está en el catálogo de '${model_id}'.`);
		}
	}
	if (kind && op && !kind.aggregations.includes(op)) {
		errors.push(`La agregación '${op}' no está permitida en '${widget_type}'.`);
	}
	if (errors.length || !kind) return { ok: false, errors };
	const limit = Number(spec.limit);
	if (Number.isFinite(limit) && limit > kind.max_rows) spec.limit = kind.max_rows;
	return { ok: true, spec };
}
