import { describe, expect, test } from 'bun:test';
import { ImperiumStore, load_catalog_path } from './store.ts';
import {
	SubjectDependencyError,
	blocking_dependents,
	dependency_graph_problems,
	missing_dependencies,
	plan_subject_install,
	type DependencyNode,
} from './subject-deps.ts';

const node = (slug: string, depends_on: string[] = []): DependencyNode => ({
	slug,
	technical_id: `subject-${slug}`,
	depends_on: depends_on.map((d) => `subject-${d}`),
});

const GRAPH = [
	node('configuracion'),
	node('almacen'),
	node('rh'),
	node('vehiculos'),
	node('ventas', ['almacen']),
	node('pos', ['almacen', 'rh']),
	node('logistica', ['ventas', 'almacen', 'vehiculos']),
];

describe('plan_subject_install', () => {
	test('instala primero las dependencias que faltan y deja el objetivo al final', () => {
		expect(plan_subject_install(GRAPH, 'subject-logistica', () => false)).toEqual({
			order: [
				'subject-almacen',
				'subject-ventas',
				'subject-vehiculos',
				'subject-logistica',
			],
			warnings: [],
		});
	});

	test('omite las que ya están listas pero recorre sus dependencias', () => {
		const ready = new Set(['subject-ventas']);
		expect(plan_subject_install(GRAPH, 'subject-logistica', (t) => ready.has(t))).toEqual({
			order: ['subject-almacen', 'subject-vehiculos', 'subject-logistica'],
			warnings: [],
		});
	});

	test('el objetivo siempre va aunque ya esté instalado (reintento)', () => {
		expect(plan_subject_install(GRAPH, 'subject-almacen', () => true)).toEqual({
			order: ['subject-almacen'],
			warnings: [],
		});
	});

	test('una app base nunca entra al plan como dependencia', () => {
		const graph = [...GRAPH, node('turnos', ['configuracion'])];
		expect(plan_subject_install(graph, 'subject-turnos', () => false)).toEqual({
			order: ['subject-turnos'],
			warnings: [],
		});
	});

	test('detecta ciclos y dependencias desconocidas', () => {
		const cyclic = [node('a', ['b']), node('b', ['a'])];
		expect(() => plan_subject_install(cyclic, 'subject-a', () => false)).toThrow(
			SubjectDependencyError,
		);
		try {
			plan_subject_install(cyclic, 'subject-a', () => false);
		} catch (err) {
			expect((err as SubjectDependencyError).code).toBe('dependency_cycle');
			expect((err as SubjectDependencyError).details.cycle).toEqual([
				'subject-a',
				'subject-b',
				'subject-a',
			]);
		}
		const unknown = [node('a', ['fantasma'])];
		try {
			plan_subject_install(unknown, 'subject-a', () => false);
			throw new Error('no lanzó');
		} catch (err) {
			expect((err as SubjectDependencyError).code).toBe('dependency_unknown');
		}
	});
});

describe('missing_dependencies', () => {
	test('lista las faltantes sin el propio objetivo', () => {
		const ready = new Set(['subject-almacen']);
		expect(missing_dependencies(GRAPH, 'subject-pos', (t) => ready.has(t))).toEqual([
			'subject-rh',
		]);
		expect(missing_dependencies(GRAPH, 'subject-almacen', () => false)).toEqual([]);
	});
});

describe('blocking_dependents', () => {
	test('bloquea con las dependientes vivas, también las transitivas', () => {
		const live = new Set(['subject-pos', 'subject-logistica']);
		expect(blocking_dependents(GRAPH, 'subject-almacen', (t) => live.has(t)).sort()).toEqual([
			'subject-logistica',
			'subject-pos',
		]);
		const only_logistica = new Set(['subject-logistica']);
		expect(
			blocking_dependents(
				[node('almacen'), node('ventas', ['almacen']), node('logistica', ['ventas'])],
				'subject-almacen',
				(t) => only_logistica.has(t),
			),
		).toEqual(['subject-logistica']);
	});

	test('sin dependientes vivas no bloquea', () => {
		expect(blocking_dependents(GRAPH, 'subject-rh', () => false)).toEqual([]);
	});

	test('un depends_on con versión sigue bloqueando la desinstalación de esa imagen', () => {
		const live = new Set(['subject-pos']);
		const graph = [
			node('almacen'),
			{
				slug: 'pos',
				technical_id: 'subject-pos',
				depends_on: ['subject-almacen@^1.2.3'],
			},
		];
		expect(blocking_dependents(graph, 'subject-almacen', (t) => live.has(t))).toEqual([
			'subject-pos',
		]);
	});
});

function imaged(
	slug: string,
	tag: string,
	depends_on: string[] = [],
	installed_tag?: string,
): DependencyNode {
	const image = `ghcr.io/opus-perpetuus/subject-${slug}:${tag}`;
	return {
		slug,
		technical_id: `subject-${slug}`,
		image,
		installed_image: installed_tag
			? `ghcr.io/opus-perpetuus/subject-${slug}:${installed_tag}`
			: undefined,
		depends_on,
	};
}

describe('dependencias entre imágenes', () => {
	test('un id sin versión no mira el tag y conserva el plan de hoy', () => {
		const graph = [imaged('almacen', '1.0.0'), imaged('pos', '0.4.0', ['subject-almacen'])];
		expect(plan_subject_install(graph, 'subject-pos', () => false)).toEqual({
			order: ['subject-almacen', 'subject-pos'],
			warnings: [],
		});
	});

	test('la imagen disponible que no es la versión exacta es error', () => {
		const graph = [
			imaged('almacen', '1.0.0'),
			imaged('pos', '0.4.0', ['subject-almacen@1.2.3']),
		];
		try {
			plan_subject_install(graph, 'subject-pos', () => false);
			throw new Error('no lanzó');
		} catch (err) {
			expect((err as SubjectDependencyError).code).toBe('dependency_version');
			expect((err as Error).message).toContain('1.0.0');
		}
	});

	test('la imagen instalada que no cumple también es error, aunque el pin sí', () => {
		const graph = [
			imaged('almacen', '1.2.3', [], '1.0.0'),
			imaged('pos', '0.4.0', ['subject-almacen@1.2.3']),
		];
		try {
			plan_subject_install(graph, 'subject-pos', () => true);
			throw new Error('no lanzó');
		} catch (err) {
			expect((err as SubjectDependencyError).code).toBe('dependency_version');
			expect((err as Error).message).toContain('1.0.0');
		}
	});

	test('un rango cumplido por otro tag advierte y devuelve el plan', () => {
		const graph = [
			imaged('almacen', '1.4.0'),
			imaged('pos', '0.4.0', ['subject-almacen@^1.2.3']),
		];
		const plan = plan_subject_install(graph, 'subject-pos', () => false);
		expect(plan.order).toEqual(['subject-almacen', 'subject-pos']);
		expect(plan.warnings.map((warning) => warning.have)).toEqual(['1.4.0']);
		expect(plan.warnings[0]?.declared).toBe('1.2.3');
	});

	test('el tag igual a la versión declarada del rango no advierte', () => {
		const graph = [
			imaged('almacen', '1.2.3'),
			imaged('pos', '0.4.0', ['subject-almacen@^1.2.3']),
		];
		expect(plan_subject_install(graph, 'subject-pos', () => false).warnings).toEqual([]);
	});

	test('el intervalo advierte dentro, falla fuera y calla en la versión declarada', () => {
		const pos = imaged('pos', '0.4.0', ['subject-almacen@>=1.2.3 <2.0.0']);
		const within = plan_subject_install(
			[imaged('almacen', '1.5.0'), pos],
			'subject-pos',
			() => false,
		);
		expect(within.warnings.map((warning) => warning.have)).toEqual(['1.5.0']);
		expect(
			plan_subject_install([imaged('almacen', '1.2.3'), pos], 'subject-pos', () => false)
				.warnings,
		).toEqual([]);
		expect(() =>
			plan_subject_install([imaged('almacen', '2.0.0'), pos], 'subject-pos', () => false),
		).toThrow(SubjectDependencyError);
	});

	test('el caret con major 0 traba el minor', () => {
		const pos = imaged('pos', '0.1.0', ['subject-almacen@^0.2.3']);
		const near = plan_subject_install(
			[imaged('almacen', '0.2.9'), pos],
			'subject-pos',
			() => false,
		);
		expect(near.warnings.map((warning) => warning.have)).toEqual(['0.2.9']);
		expect(() =>
			plan_subject_install([imaged('almacen', '0.3.0'), pos], 'subject-pos', () => false),
		).toThrow(SubjectDependencyError);
	});

	test('una imagen de otra organización también se compara por su tag', () => {
		const almacen: DependencyNode = {
			slug: 'almacen',
			technical_id: 'subject-almacen',
			image: 'ghcr.io/codice-progressio/subject-almacen:1.4.0',
		};
		const plan = plan_subject_install(
			[almacen, imaged('pos', '0.4.0', ['subject-almacen@^1.2.3'])],
			'subject-pos',
			() => false,
		);
		expect(plan.warnings.map((warning) => warning.have)).toEqual(['1.4.0']);
	});

	test('una app base con sufijo de versión no entra al plan ni falla', () => {
		const graph = [
			imaged('configuracion', '0.0.1'),
			imaged('turnos', '0.1.0', ['subject-configuracion@9.9.9']),
		];
		expect(plan_subject_install(graph, 'subject-turnos', () => false)).toEqual({
			order: ['subject-turnos'],
			warnings: [],
		});
	});

	test('una restricción posterior se juzga aunque el id ya esté en el plan', () => {
		const almacen = imaged('almacen', '9.0.0');
		const ready = () => false;
		const late = [
			almacen,
			imaged('a', '1.0.0', ['subject-almacen']),
			imaged('b', '1.0.0', ['subject-almacen@1.2.3']),
			imaged('c', '1.0.0', ['subject-a', 'subject-b']),
		];
		expect(() => plan_subject_install(late, 'subject-c', ready)).toThrow(SubjectDependencyError);
		const early = [
			almacen,
			imaged('a', '1.0.0', ['subject-almacen']),
			imaged('b', '1.0.0', ['subject-almacen@1.2.3']),
			imaged('c', '1.0.0', ['subject-b', 'subject-a']),
		];
		expect(() => plan_subject_install(early, 'subject-c', ready)).toThrow(SubjectDependencyError);
		try {
			plan_subject_install(late, 'subject-c', ready);
		} catch (err) {
			expect((err as SubjectDependencyError).code).toBe('dependency_version');
		}
	});

	test('un ciclo y una imagen ausente del catálogo siguen siendo error', () => {
		const cyclic = [
			imaged('a', '1.0.0', ['subject-b@1.0.0']),
			imaged('b', '1.0.0', ['subject-a@1.0.0']),
		];
		expect(() => plan_subject_install(cyclic, 'subject-a', () => false)).toThrow(
			SubjectDependencyError,
		);
		try {
			plan_subject_install([imaged('a', '1.0.0', ['subject-fantasma@1.0.0'])], 'subject-a', () => false);
			throw new Error('no lanzó');
		} catch (err) {
			expect((err as SubjectDependencyError).code).toBe('dependency_unknown');
		}
	});
});

describe('grafo del catálogo', () => {
	test('el catálogo real no tiene ciclos, ids desconocidos ni bases con dependencias', () => {
		const store = new ImperiumStore(null as unknown as Bun.SQL, load_catalog_path());
		expect(dependency_graph_problems(store.subjects)).toEqual([]);
	});

	test('el catálogo declara las dependencias duras conocidas', () => {
		const store = new ImperiumStore(null as unknown as Bun.SQL, load_catalog_path());
		const deps = Object.fromEntries(
			store.subjects.map((s) => [s.slug, [...(s.depends_on ?? [])].sort()]),
		);
		expect(deps.ventas).toEqual(['subject-almacen']);
		expect(deps.pos).toEqual(['subject-almacen', 'subject-rh']);
		expect(deps.logistica).toEqual(['subject-almacen', 'subject-vehiculos', 'subject-ventas']);
	});

	test('dependency_graph_problems explica cada error', () => {
		expect(
			dependency_graph_problems([
				node('configuracion', ['almacen']),
				node('almacen', ['almacen', 'configuracion']),
				node('ventas', ['almacen', 'almacen', 'nada']),
			]),
		).toEqual([
			'subject-configuracion: una app base no puede declarar dependencias',
			'subject-almacen: depende de sí misma',
			'subject-almacen: subject-configuracion es base, no se declara',
			'subject-ventas: subject-almacen repetida',
			'subject-ventas: subject-nada no está en el catálogo',
		]);
		expect(dependency_graph_problems([node('mode')])).toEqual([
			"subject-mode: el slug 'mode' está reservado",
		]);
	});
});
