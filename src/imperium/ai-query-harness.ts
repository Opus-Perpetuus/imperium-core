export type QueryFilter = {
	field: string;
	op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte';
	value: string;
};

export type QueryStep = {
	model_id: string;
	title: string;
	search: string;
	limit: number | null;
	sort: string;
	widget_type: string;
	aggregation: { op: string; field: string } | null;
	filters: QueryFilter[];
};

const STATUS_VALUE: Record<string, string> = {
	confirmada: 'confirmado',
	confirmadas: 'confirmado',
	confirmado: 'confirmado',
	confirmados: 'confirmado',
	confirmed: 'confirmado',
	cancelada: 'cancelado',
	canceladas: 'cancelado',
	cancelado: 'cancelado',
	cancelados: 'cancelado',
	borrador: 'borrador',
	borradores: 'borrador',
	surtido: 'surtido',
	surtidos: 'surtido',
	surtiendo: 'surtiendo',
	por_surtir: 'por_surtir',
	'por surtir': 'por_surtir',
};

export type QueryPlan = {
	answer: string;
	steps: QueryStep[];
	detail: string[];
};

const OPS = new Set(['eq', 'lt', 'lte', 'gt', 'gte']);

function as_record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function as_list(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (value && typeof value === 'object') return [value];
	return [];
}

function limit_of(value: unknown): number | null {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return null;
	return Math.min(100, Math.floor(n));
}

function filters_of(value: unknown): QueryFilter[] {
	const out: QueryFilter[] = [];
	for (const item of as_list(value)) {
		const row = as_record(item);
		const field = String(row.field ?? '').trim();
		const op = String(row.op ?? 'eq').trim().toLowerCase();
		const raw = row.value;
		if (!field || raw == null || raw === '' || !OPS.has(op)) continue;
		out.push({ field, op: op as QueryFilter['op'], value: String(raw) });
	}
	return out.slice(0, 4);
}

function escape_re(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pull_status(search: string): { search: string; status: string | null } {
	const keys = Object.keys(STATUS_VALUE).sort((a, b) => b.length - a.length);
	for (const key of keys) {
		const pattern = new RegExp(
			`(?:^|[^\\p{L}\\p{N}_])${escape_re(key)}(?=$|[^\\p{L}\\p{N}_])`,
			'iu',
		);
		if (!pattern.test(search)) continue;
		const next = search
			.replace(pattern, ' ')
			.replace(/\s*[,.;:]+\s*/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		return { search: next, status: STATUS_VALUE[key] };
	}
	return { search, status: null };
}

function widget_type_of(raw: string, aggregation_op: string): string {
	if (aggregation_op === 'sum') return 'kpi';
	const text = raw.trim().toLowerCase();
	if (text === 'kpi' || text === 'progress') return text;
	if (text.startsWith('chart-')) return text;
	if (text === 'chart') return 'chart-bar';
	return 'table';
}

function answer_of(source: Record<string, unknown>, steps: QueryStep[]): string {
	const answer = String(source.answer ?? source.text ?? source.message ?? '').trim();
	if (answer || !steps.length) return answer;
	const titles = steps.map((step) => step.title || step.model_id);
	return titles.length === 1 ? `Mostrando ${titles[0]}.` : `Mostrando ${titles.join(', ')}.`;
}

function step_of(value: unknown): QueryStep | null {
	const row = as_record(value);
	const model_id = String(row.model_id ?? row.model ?? '').trim();
	if (!model_id) return null;
	const aggregation = as_record(row.aggregation);
	let aggregation_op = String(aggregation.op ?? '').trim().toLowerCase();
	let aggregation_field = String(aggregation.field ?? '').trim();
	if (aggregation_op === 'sum' && !aggregation_field) aggregation_field = 'total';
	const aggregation_value =
		aggregation_op && aggregation_field ? { op: aggregation_op, field: aggregation_field } : null;
	const filters = filters_of(row.filters).map((filter) => {
		const mapped = STATUS_VALUE[filter.value.trim().toLowerCase()];
		return mapped ? { ...filter, value: mapped } : filter;
	});
	const pulled = pull_status(String(row.search ?? '').trim());
	const search = pulled.search;
	if (pulled.status && !filters.some((filter) => filter.field === 'estado')) {
		filters.unshift({ field: 'estado', op: 'eq', value: pulled.status });
	}
	return {
		model_id,
		title: String(row.title ?? model_id),
		search,
		limit: limit_of(row.limit),
		sort: String(row.sort ?? '').trim(),
		widget_type: widget_type_of(String(row.widget_type ?? ''), aggregation_value?.op ?? ''),
		aggregation: aggregation_value,
		filters,
	};
}

export function plan_from_model(raw: Record<string, unknown>): QueryPlan {
	const nested = as_record(raw.result ?? raw.data);
	const source = Object.keys(nested).length ? { ...raw, ...nested } : raw;
	const steps = as_list(source.steps ?? source.widgets ?? source.widget ?? source.items)
		.map(step_of)
		.filter((step): step is QueryStep => Boolean(step))
		.slice(0, 3);
	if (!steps.length) {
		const lone = step_of(source);
		if (lone) steps.push(lone);
	}
	const detail = as_list(source.detail ?? source.describe)
		.map((id) => String(id).trim())
		.filter(Boolean)
		.slice(0, 4);
	return {
		answer: answer_of(source, steps),
		steps,
		detail,
	};
}

export function widgets_from_plan(plan: QueryPlan) {
	return plan.steps.map((step) => ({
		widget_type: step.widget_type || 'table',
		model_id: step.model_id,
		title: step.title,
		search: step.search,
		limit: step.limit,
		sort: step.sort,
		filters: step.filters,
		aggregation: step.aggregation,
	}));
}

export function pick_model_object(text: string): Record<string, unknown> | null {
	const found: Record<string, unknown>[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== '{') continue;
		const end = end_of_object(text, i);
		if (end < 0) continue;
		try {
			const parsed = JSON.parse(text.slice(i, end + 1));
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) found.push(parsed);
		} catch {
			continue;
		}
	}
	const preferred = found.find((item) => 'steps' in item || 'widgets' in item || 'model_id' in item || 'answer' in item);
	return preferred ?? found[0] ?? null;
}

function end_of_object(text: string, start: number): number {
	let depth = 0;
	let quote = '';
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (quote) {
			if (char === '\\') {
				i += 1;
				continue;
			}
			if (char === quote) quote = '';
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === '{') depth += 1;
		if (char === '}') {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

export function detail_fields(entries: unknown[], ids: string[]): string {
	const wanted = new Set(ids.map((id) => id.toLowerCase()));
	return entries
		.map((entry) => as_record(entry))
		.filter((entry) => wanted.has(String(entry.model_id ?? '').toLowerCase()))
		.slice(0, 4)
		.map((entry) => {
			const names = as_list(entry.fields)
				.map((field) => String(as_record(field).path ?? ''))
				.filter(Boolean)
				.slice(0, 24);
			return `- ${entry.model_id}: ${names.join(', ')}`;
		})
		.join('\n');
}
