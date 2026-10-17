import { is_base_subject_slug } from './subject-runtime.ts';
import { compare_semver, parse_semver, type Semver } from './subject-versions.ts';

/**
 * Dependencias entre imágenes de apps. `depends_on` nombra el technical id y,
 * si lleva `@`, el tag que debe tener la imagen de esa app (la instalada y la
 * disponible). Sin `@` el plan solo ordena el grafo. Las apps base cuentan
 * siempre como instaladas y nunca declaran dependencias.
 */
export type DependencyNode = {
	technical_id: string;
	slug: string;
	name?: string;
	depends_on?: string[];
	/** Imagen disponible (pin del catálogo o la que se instalaría). */
	image?: string | null;
	/** Imagen que ya corre, si el registro la conoce. */
	installed_image?: string | null;
};

export type SubjectDependencyErrorCode =
	| 'dependency_cycle'
	| 'dependency_unknown'
	| 'dependency_version';

export class SubjectDependencyError extends Error {
	constructor(
		message: string,
		readonly code: SubjectDependencyErrorCode,
		readonly details: Record<string, unknown>,
	) {
		super(message);
	}
}

/** El tag cumple el rango, pero no es la versión exacta que la otra imagen declaró. */
export type ImageDependencyWarning = {
	technical_id: string;
	required_by: string;
	constraint: string;
	declared: string;
	have: string;
	image: string;
	message: string;
};

export type InstallPlan = {
	order: string[];
	warnings: ImageDependencyWarning[];
};

type ImageDepRef = {
	technical_id: string;
	constraint: string | null;
};

export function parse_image_dep(raw: string): ImageDepRef {
	const text = String(raw ?? '').trim();
	const at = text.indexOf('@');
	if (at < 0) return { technical_id: text, constraint: null };
	const technical_id = text.slice(0, at).trim();
	const constraint = text.slice(at + 1).trim();
	return { technical_id, constraint: constraint || null };
}

function index_nodes(subjects: readonly DependencyNode[]) {
	return new Map(subjects.map((s) => [s.technical_id, s]));
}

function display(node: DependencyNode | undefined, tid: string) {
	return node?.name ?? node?.slug ?? tid;
}

/** Tag `X.Y.Z` de una referencia `registro/subject-slug:tag`. Otro tag no es versión. */
function image_semver(image: string | null | undefined): string | null {
	const raw = String(image ?? '').trim();
	if (!raw.includes(':')) return null;
	const tag = raw.split(':').pop() ?? '';
	return parse_semver(tag) ? tag : null;
}

type Cmp = '=' | '>=' | '>' | '<=' | '<';

type ParsedConstraint = {
	declared: string;
	satisfies: (tag: string) => boolean;
};

function cmp_ok(op: Cmp, have: Semver, want: Semver): boolean {
	const diff = compare_semver(have, want);
	if (op === '=') return diff === 0;
	if (op === '>=') return diff >= 0;
	if (op === '>') return diff > 0;
	if (op === '<=') return diff <= 0;
	return diff < 0;
}

function bounds_of(
	declared: string,
	bounds: ReadonlyArray<{ op: Cmp; version: Semver }>,
): ParsedConstraint {
	return {
		declared,
		satisfies: (tag) => {
			const have = parse_semver(tag);
			if (!have) return false;
			return bounds.every((bound) => cmp_ok(bound.op, have, bound.version));
		},
	};
}

/**
 * Caret de npm: `^1.2.3` es `>=1.2.3 <2.0.0`. Con major 0 traba el minor
 * (`^0.2.3` → `<0.3.0`) y con `0.0.x` traba el parche.
 */
function caret_constraint(raw: string): ParsedConstraint | null {
	const version = parse_semver(raw);
	if (!version) return null;
	const upper: Semver =
		version[0] > 0
			? [version[0] + 1, 0, 0]
			: version[1] > 0
				? [0, version[1] + 1, 0]
				: [0, 0, version[2] + 1];
	return bounds_of(raw, [
		{ op: '>=', version },
		{ op: '<', version: upper },
	]);
}

function tilde_constraint(raw: string): ParsedConstraint | null {
	const version = parse_semver(raw);
	if (!version) return null;
	return bounds_of(raw, [
		{ op: '>=', version },
		{ op: '<', version: [version[0], version[1] + 1, 0] },
	]);
}

function comparator_constraint(parts: readonly string[]): ParsedConstraint | null {
	const bounds: Array<{ op: Cmp; version: Semver }> = [];
	let declared: string | null = null;
	for (const part of parts) {
		const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(part);
		if (!match) return null;
		const version = parse_semver(match[2]);
		if (!version) return null;
		declared ??= match[2]!;
		bounds.push({ op: (match[1] || '=') as Cmp, version });
	}
	if (!declared || !bounds.length) return null;
	return bounds_of(declared, bounds);
}

function parse_constraint(constraint: string): ParsedConstraint | null {
	const parts = constraint.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 1) {
		const one = parts[0]!;
		if (one.startsWith('^')) return caret_constraint(one.slice(1));
		if (one.startsWith('~')) return tilde_constraint(one.slice(1));
	}
	return comparator_constraint(parts);
}

function version_error(
	message: string,
	details: Record<string, unknown>,
): SubjectDependencyError {
	return new SubjectDependencyError(message, 'dependency_version', details);
}

/**
 * Copia `installed_image` desde el registro de instalación. Sin imagen conocida
 * el nodo sigue igual: no se inventa un tag.
 */
export function with_installed_images<T extends DependencyNode>(
	subjects: readonly T[],
	installed_images: ReadonlyMap<string, string | null | undefined>,
): T[] {
	return subjects.map((subject) => {
		const installed = String(installed_images.get(subject.technical_id) ?? '').trim();
		if (!installed) return subject;
		return { ...subject, installed_image: installed };
	});
}

/**
 * Apps a instalar para `target`, dependencias primero y `target` al final.
 * Recorre también las dependencias ya listas para reparar estados a medias
 * (POS instalado sin RH), pero solo devuelve las que faltan.
 *
 * Una restricción compara el tag de la imagen instalada y el de la disponible.
 * Si alguna no entra, es error. Si entra y no es la versión declarada, es
 * advertencia y el orden se devuelve igual. Un id sin versión no mira tags.
 * Una app base no entra al plan aunque el id traiga sufijo.
 */
export function plan_subject_install(
	subjects: readonly DependencyNode[],
	target: string,
	is_ready: (technical_id: string) => boolean,
): InstallPlan {
	const by_tid = index_nodes(subjects);
	const target_id = parse_image_dep(target).technical_id;
	if (!by_tid.has(target_id)) {
		throw new SubjectDependencyError(`App desconocida: ${target_id}`, 'dependency_unknown', {
			technical_id: target_id,
		});
	}
	const plan: string[] = [];
	const warnings: ImageDependencyWarning[] = [];
	const warned = new Set<string>();
	const state = new Map<string, 'visiting' | 'done'>();
	const stack: string[] = [];

	const judge = (node: DependencyNode, ref: ImageDepRef, required_by: string) => {
		const constraint = ref.constraint;
		if (!constraint || is_base_subject_slug(node.slug)) return;
		const parsed = parse_constraint(constraint);
		const parent = by_tid.get(required_by);
		const details = {
			technical_id: node.technical_id,
			required_by,
			constraint,
		};
		if (!parsed) {
			throw version_error(
				`${display(parent, required_by)} pide una versión ilegible de ${display(node, node.technical_id)} (${constraint})`,
				details,
			);
		}
		const images = [node.installed_image, node.image]
			.map((image) => String(image ?? '').trim())
			.filter(Boolean);
		if (!images.length) {
			throw version_error(
				`No hay imagen de ${display(node, node.technical_id)} que cumpla ${constraint} que pide ${display(parent, required_by)}`,
				{ ...details, declared: parsed.declared },
			);
		}
		for (const image of images) {
			const have = image_semver(image);
			if (!have || !parsed.satisfies(have)) {
				throw version_error(
					`La imagen de ${display(node, node.technical_id)} es ${have || 'sin tag semver'}; ${display(parent, required_by)} pide ${constraint}`,
					{ ...details, declared: parsed.declared, have: have ?? '', image },
				);
			}
			if (have === parsed.declared) continue;
			const key = `${required_by}\0${node.technical_id}\0${constraint}\0${have}`;
			if (warned.has(key)) continue;
			warned.add(key);
			warnings.push({
				technical_id: node.technical_id,
				required_by,
				constraint,
				declared: parsed.declared,
				have,
				image,
				message: `La imagen de ${display(node, node.technical_id)} es ${have}; ${display(parent, required_by)} declaró ${parsed.declared} (${constraint})`,
			});
		}
	};

	const visit = (raw: string, required_by?: string) => {
		const ref = parse_image_dep(raw);
		const tid = ref.technical_id;
		const node = by_tid.get(tid);
		if (!node) {
			throw new SubjectDependencyError(
				`${display(by_tid.get(required_by ?? ''), required_by ?? '')} depende de ${tid}, que no está en el catálogo`,
				'dependency_unknown',
				{ technical_id: tid, required_by },
			);
		}
		const seen = state.get(tid);
		if (seen === 'visiting') {
			const cycle = [...stack.slice(stack.indexOf(tid)), tid];
			throw new SubjectDependencyError(
				`Dependencias circulares: ${cycle.map((t) => display(by_tid.get(t), t)).join(' → ')}`,
				'dependency_cycle',
				{ cycle },
			);
		}
		// Otra app puede pedir @versión del mismo id que ya se recorrió.
		if (required_by) judge(node, ref, required_by);
		if (seen === 'done') return;
		state.set(tid, 'visiting');
		stack.push(tid);
		if (!is_base_subject_slug(node.slug)) {
			for (const dep of node.depends_on ?? []) visit(dep, tid);
		}
		stack.pop();
		state.set(tid, 'done');
		if (tid === target_id) return;
		if (!is_base_subject_slug(node.slug) && !is_ready(tid)) plan.push(tid);
	};

	visit(target_id);
	plan.push(target_id);
	return { order: plan, warnings };
}

/** Dependencias (directas o transitivas) de `technical_id` que aún no están listas. */
export function missing_dependencies(
	subjects: readonly DependencyNode[],
	technical_id: string,
	is_ready: (technical_id: string) => boolean,
): string[] {
	return plan_subject_install(subjects, technical_id, is_ready).order.filter(
		(tid) => tid !== technical_id,
	);
}

/**
 * Apps vivas que dependen de `target`, aunque sea a través de otra que ya no
 * esté viva: quitar `target` las dejaría rotas. El sufijo `@versión` no cambia
 * de qué imagen se trata.
 */
export function blocking_dependents(
	subjects: readonly DependencyNode[],
	target: string,
	is_live: (technical_id: string) => boolean,
): string[] {
	const reverse = new Map<string, string[]>();
	for (const s of subjects) {
		for (const dep of s.depends_on ?? []) {
			const id = parse_image_dep(dep).technical_id;
			const list = reverse.get(id) ?? [];
			list.push(s.technical_id);
			reverse.set(id, list);
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
			const id = parse_image_dep(dep).technical_id;
			if (id === s.technical_id) problems.push(`${s.technical_id}: depende de sí misma`);
			if (seen.has(id)) problems.push(`${s.technical_id}: ${id} repetida`);
			seen.add(id);
			if (!by_tid.has(id)) problems.push(`${s.technical_id}: ${id} no está en el catálogo`);
			else if (is_base_subject_slug(by_tid.get(id)!.slug)) {
				problems.push(`${s.technical_id}: ${id} es base, no se declara`);
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
