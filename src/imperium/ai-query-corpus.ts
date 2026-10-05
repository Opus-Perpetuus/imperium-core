import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pick_model_object, plan_from_model, type QueryStep } from './ai-query-harness.ts';

export type CorpusWidget = { model_id: string; widget_type: string };

export type CorpusQuestion = {
	id: string;
	tier: number;
	intent: string;
	prompt: string;
	widgets: CorpusWidget[];
};

export type CorpusFixture = {
	id: string;
	raw: Record<string, unknown> | string;
	answer: string;
	steps: QueryStep[];
};

export type TranscriptWidget = {
	model_id: string;
	widget_type: string;
	spec?: Record<string, unknown>;
};

export type TranscriptLine = {
	id?: string;
	prompt: string;
	assistant?: string;
	error?: string;
	api_answer?: string;
	http_status?: number;
	widgets?: TranscriptWidget[];
	requested_at?: string;
	settled_at?: string;
};

export type ScoreHit = {
	id: string;
	prompt: string;
	status: 'pass' | 'fail' | 'residual';
	kind: 'ok' | 'mismatch' | 'empty' | 'chart_fallback' | 'env' | 'harness' | 'model_choice';
	reason: string;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const BANNED = /\b(nvidia|openai|anthropic|xai|opencode|deepseek|claude|gemini|llama|qwen|gpt|grok)\b/i;
const ENV_TEXT =
	/tiempo de espera|timeout|abort|cr[eé]dito|cuota|quota|insufficient|econn|fetch failed|network|conexi[oó]n|agotad|\b(?:401|403|408|429|500|502|503|504)\b/i;
const ENV_STATUS = new Set([401, 403, 408, 429, 500, 502, 503, 504]);

type CorpusFile = { questions: CorpusQuestion[]; fixtures: CorpusFixture[] };

function read_json<T>(name: string): T {
	return JSON.parse(readFileSync(join(HERE, name), 'utf8')) as T;
}

export function load_corpus(): CorpusFile {
	return read_json<CorpusFile>('ai-query-corpus.json');
}

export function load_catalog_ids(): string[] {
	return read_json<string[]>('ai-query-catalog-ids.json');
}

export type CorpusSummary = {
	ok: boolean;
	count: number;
	intents: number;
	min_variants: number;
	tiers: 'non-decreasing' | 'decreasing';
	unknown_model_ids: number;
	provider_strings: number;
};

export function validate_corpus(
	corpus: CorpusFile = load_corpus(),
	catalog_ids: string[] = load_catalog_ids(),
): CorpusSummary {
	const allowed = new Set(catalog_ids);
	const by_intent = new Map<string, number>();
	let decreasing = false;
	let unknown = 0;
	const prompts = new Set<string>();
	for (let i = 0; i < corpus.questions.length; i++) {
		const question = corpus.questions[i]!;
		prompts.add(question.prompt);
		by_intent.set(question.intent, (by_intent.get(question.intent) ?? 0) + 1);
		if (i > 0 && question.tier < corpus.questions[i - 1]!.tier) decreasing = true;
		for (const widget of question.widgets) {
			if (!allowed.has(widget.model_id)) unknown += 1;
		}
	}
	const provider_strings = BANNED.test(JSON.stringify(corpus)) ? 1 : 0;
	const counts = [...by_intent.values()];
	const summary: CorpusSummary = {
		ok: false,
		count: corpus.questions.length,
		intents: by_intent.size,
		min_variants: counts.length ? Math.min(...counts) : 0,
		tiers: decreasing ? 'decreasing' : 'non-decreasing',
		unknown_model_ids: unknown,
		provider_strings,
	};
	summary.ok =
		summary.count >= 48 &&
		summary.intents >= 8 &&
		summary.min_variants >= 3 &&
		prompts.size === corpus.questions.length &&
		summary.tiers === 'non-decreasing' &&
		summary.unknown_model_ids === 0 &&
		summary.provider_strings === 0;
	return summary;
}

export function format_summary(summary: CorpusSummary): string {
	return [
		`count ${summary.count}`,
		`intents ${summary.intents}`,
		`min_variants ${summary.min_variants}`,
		`tiers ${summary.tiers}`,
		`unknown_model_ids ${summary.unknown_model_ids}`,
		`provider_strings ${summary.provider_strings}`,
		`ok ${summary.ok}`,
	].join('\n');
}

function widget_key(widget: CorpusWidget): string {
	return `${widget.model_id}\0${widget.widget_type}`;
}

function same_widgets(actual: CorpusWidget[], expected: CorpusWidget[]): boolean {
	if (actual.length !== expected.length) return false;
	const bag = actual.map(widget_key);
	for (const widget of expected) {
		const index = bag.indexOf(widget_key(widget));
		if (index < 0) return false;
		bag.splice(index, 1);
	}
	return true;
}

function specs_of(line: TranscriptLine): Record<string, unknown>[] {
	return (line.widgets ?? []).map((widget) => widget.spec ?? { model_id: widget.model_id, widget_type: widget.widget_type });
}

export function replay_line(line: TranscriptLine) {
	return plan_from_model({
		answer: line.api_answer ?? '',
		steps: specs_of(line),
	});
}

export function is_environment(line: TranscriptLine): boolean {
	if (line.http_status != null && ENV_STATUS.has(line.http_status)) return true;
	const error = String(line.error ?? '').trim();
	const visible = String(line.assistant ?? '').trim();
	if (!visible && error && (line.http_status === 0 || line.http_status == null)) return true;
	return ENV_TEXT.test(`${error}\n${line.assistant ?? ''}`);
}

export function fixture_plan(fixture: CorpusFixture) {
	const raw = typeof fixture.raw === 'string' ? pick_model_object(fixture.raw) : fixture.raw;
	if (!raw) return null;
	return plan_from_model(raw);
}

export function score_line(line: TranscriptLine, question: CorpusQuestion): ScoreHit {
	const id = line.id || question.id;
	const visible = String(line.assistant ?? '').trim();
	const error = String(line.error ?? '').trim();
	const actual = (line.widgets ?? []).map((widget) => ({
		model_id: widget.model_id,
		widget_type: widget.widget_type,
	}));
	const expected = question.widgets;
	const base = { id, prompt: question.prompt };
	if (!visible && (error || is_environment(line))) {
		return { ...base, status: 'residual', kind: 'env', reason: error || `http ${line.http_status ?? ''}`.trim() };
	}
	const replay = replay_line(line);
	const replay_widgets = replay.steps.map((step) => ({
		model_id: step.model_id,
		widget_type: step.widget_type,
	}));
	const harness_fixes_widgets = !same_widgets(actual, expected) && same_widgets(replay_widgets, expected);
	const harness_fills_answer = !visible && !String(line.api_answer ?? '').trim() && Boolean(replay.answer.trim());
	if (harness_fixes_widgets || harness_fills_answer) {
		return {
			...base,
			status: 'fail',
			kind: 'harness',
			reason: harness_fills_answer ? 'respuesta vacía que la normalización ya llena' : 'el plan capturado no pasó por la normalización',
		};
	}
	if (!visible) {
		return { ...base, status: 'fail', kind: 'empty', reason: 'texto del asistente vacío' };
	}
	if (expected.length === 0) {
		if (actual.length) {
			return { ...base, status: 'residual', kind: 'model_choice', reason: 'había widgets y se esperaba solo texto' };
		}
		return { ...base, status: 'pass', kind: 'ok', reason: 'texto sin widgets' };
	}
	if (same_widgets(actual, expected)) {
		return { ...base, status: 'pass', kind: 'ok', reason: 'modelo y tipo coinciden' };
	}
	const chart = expected.some((widget) => widget.widget_type === 'table') &&
		actual.some((widget) => widget.widget_type.startsWith('chart'));
	if (chart) {
		return { ...base, status: 'residual', kind: 'chart_fallback', reason: 'la lista llegó como gráfica' };
	}
	const got = actual.map((widget) => `${widget.model_id}/${widget.widget_type}`).join(', ') || 'sin widgets';
	return { ...base, status: 'residual', kind: 'model_choice', reason: `se esperaba otra lista y llegó ${got}` };
}

export function score_transcript(lines: TranscriptLine[], questions: CorpusQuestion[] = load_corpus().questions): ScoreHit[] {
	const by_id = new Map(questions.map((question) => [question.id, question]));
	const by_prompt = new Map(questions.map((question) => [question.prompt, question]));
	return lines.map((line) => {
		const question = (line.id && by_id.get(line.id)) || by_prompt.get(line.prompt);
		if (!question) {
			return {
				id: line.id || '',
				prompt: line.prompt,
				status: 'fail' as const,
				kind: 'mismatch' as const,
				reason: 'la línea no está en el corpus',
			};
		}
		return score_line(line, question);
	});
}

export function format_score(hits: ScoreHit[], lines: TranscriptLine[] = []): string {
	const pass = hits.filter((hit) => hit.status === 'pass').length;
	const residual = hits.filter((hit) => hit.status === 'residual');
	const harness = hits.filter((hit) => hit.kind === 'harness');
	const fail = hits.filter((hit) => hit.status !== 'pass');
	const gaps = request_gaps(lines);
	const lines_out = [
		'# AI chat corpus score',
		'',
		`- lines: ${hits.length}`,
		`- pass: ${pass}`,
		`- fail: ${fail.length}`,
		`- residual: ${residual.length}`,
		`- harness_owned: ${harness.length}`,
		`- min_gap_ms: ${gaps.min_ms === null ? 'n/a' : gaps.min_ms}`,
		`- gap_ok: ${gaps.ok}`,
		'',
		'## Failing prompts',
	];
	if (!fail.length) lines_out.push('- none');
	for (const hit of fail) {
		lines_out.push(`- ${hit.id} | ${hit.kind} | ${hit.prompt} | ${hit.reason}`);
	}
	lines_out.push('', '## Residuals');
	if (!residual.length) lines_out.push('- none');
	for (const hit of residual) {
		lines_out.push(`- ${hit.id} | ${hit.kind} | ${hit.prompt} | ${hit.reason}`);
	}
	return lines_out.join('\n') + '\n';
}

function request_gaps(lines: TranscriptLine[]): { min_ms: number | null; ok: boolean } {
	const times = lines
		.map((line) => Date.parse(line.requested_at ?? ''))
		.filter((time) => Number.isFinite(time));
	if (times.length < 2) return { min_ms: null, ok: true };
	let min = Number.POSITIVE_INFINITY;
	for (let i = 1; i < times.length; i++) min = Math.min(min, times[i]! - times[i - 1]!);
	return { min_ms: min, ok: min >= 3000 };
}
