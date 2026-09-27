import { is_base_subject_slug } from './subject-runtime.ts';

/**
 * Dependencias entre apps. El catálogo declara `depends_on` (technical ids) y el
 * núcleo las resuelve al instalar, actualizar y desinstalar. Las apps base cuentan
 * siempre como instaladas y nunca declaran dependencias.
 */
export type DependencyNode = {
	technical_id: string;
	slug: string;
	name?: string;
	depends_on?: string[];
};

export type SubjectDependencyErrorCode = 'dependency_cycle' | 'dependency_unknown';

export class SubjectDependencyError extends Error {
	constructor(
		message: string,
		readonly code: SubjectDependencyErrorCode,
		readonly details: Record<string, unknown>,
	) {
		super(message);
	}
}

function index_nodes(subjects: readonly DependencyNode[]) {
	return new Map(subjects.map((s) => [s.technical_id, s]));
}

function display(node: DependencyNode | undefined, tid: string) {
	return node?.name ?? node?.slug ?? tid;
}

/**
 * Apps a instalar para `target`, dependencias primero y `target` al final.
 * Recorre también las dependencias ya listas para reparar estados a medias
 * (POS instalado sin RH), pero solo devuelve las que faltan.
 */
export function plan_subject_install(
	subjects: readonly DependencyNode[],
	target: string,
	is_ready: (technical_id: string) => boolean,
): string[] {
	const by_tid = index_nodes(subjects);
	if (!by_tid.has(target)) {
		throw new SubjectDependencyError(`App desconocida: ${target}`, 'dependency_unknown', {
			technical_id: target,
		});
	}
	const plan: string[] = [];
	const state = new Map<string, 'visiting' | 'done'>();
	const stack: string[] = [];

	const visit = (tid: string, required_by?: string) => {
		const node = by_tid.get(tid);
		if (!node) {
			throw new SubjectDependencyError(
				`${display(by_tid.get(required_by ?? ''), required_by ?? '')} depende de ${tid}, que no está en el catálogo`,
				'dependency_unknown',
				{ technical_id: tid, required_by },
			);
		}
		const seen = state.get(tid);
		if (seen === 'done') return;
		if (seen === 'visiting') {
			const cycle = [...stack.slice(stack.indexOf(tid)), tid];
			throw new SubjectDependencyError(
				`Dependencias circulares: ${cycle.map((t) => display(by_tid.get(t), t)).join(' → ')}`,
				'dependency_cycle',
				{ cycle },
			);
		}
		state.set(tid, 'visiting');
		stack.push(tid);
		if (!is_base_subject_slug(node.slug)) {
			for (const dep of node.depends_on ?? []) visit(dep, tid);
		}
		stack.pop();
		state.set(tid, 'done');
		if (tid === target) return;
		if (!is_base_subject_slug(node.slug) && !is_ready(tid)) plan.push(tid);
	};

	visit(target);
	plan.push(target);
	return plan;
}

/** Dependencias (directas o transitivas) de `technical_id` que aún no están listas. */
export function missing_dependencies(
	subjects: readonly DependencyNode[],
	technical_id: string,
	is_ready: (technical_id: string) => boolean,
): string[] {
	return plan_subject_install(subjects, technical_id, is_ready).filter(
		(tid) => tid !== technical_id,
	);
}

/**
 * Apps vivas que dependen de `target`, aunque sea a través de otra que ya no
 * esté viva: quitar `target` las dejaría rotas.
 */
export function blocking_dependents(
	subjects: readonly DependencyNode[],
	target: string,
	is_live: (technical_id: string) => boolean,
): string[] {
	const reverse = new Map<string, string[]>();
	for (const s of subjects) {
		for (const dep of s.depends_on ?? []) {
			const list = reverse.get(dep) ?? [];
			list.push(s.technical_id);
			reverse.set(dep, list);
		}
	}
	const seen = new Set<string>([target]);
	const queue = [target];
	const out: string[] = [];
	while (queue.length) {
		const tid = queue.shift()!;
		for (const dependent of reverse.get(tid) ?? []) {
			if (seen.has(dependent)) continue;
			seen.add(dependent);
			queue.push(dependent);
			if (is_live(dependent)) out.push(dependent);
		}
	}
	return out;
}

/** Problemas del grafo del catálogo; vacío = válido. */
export function dependency_graph_problems(subjects: readonly DependencyNode[]): string[] {
	const by_tid = index_nodes(subjects);
	const problems: string[] = [];
	for (const s of subjects) {
		const deps = s.depends_on ?? [];
		// CORE_SUBJECT_SECRET_<SLUG> del host chocaría con CORE_SUBJECT_SECRET_MODE.
		if (s.slug === 'mode') problems.push(`${s.technical_id}: el slug 'mode' está reservado`);
		if (deps.length && is_base_subject_slug(s.slug)) {
			problems.push(`${s.technical_id}: una app base no puede declarar dependencias`);
		}
		const seen = new Set<string>();
		for (const dep of deps) {
			if (dep === s.technical_id) problems.push(`${s.technical_id}: depende de sí misma`);
			if (seen.has(dep)) problems.push(`${s.technical_id}: ${dep} repetida`);
			seen.add(dep);
			if (!by_tid.has(dep)) problems.push(`${s.technical_id}: ${dep} no está en el catálogo`);
			else if (is_base_subject_slug(by_tid.get(dep)!.slug)) {
				problems.push(`${s.technical_id}: ${dep} es base, no se declara`);
			}
		}
	}
	if (problems.length) return problems;
	for (const s of subjects) {
		try {
			plan_subject_install(subjects, s.technical_id, () => false);
		} catch (err) {
			problems.push(`${s.technical_id}: ${(err as Error).message}`);
		}
	}
	return problems;
}
