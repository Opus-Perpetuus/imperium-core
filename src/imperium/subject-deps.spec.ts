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
		expect(plan_subject_install(GRAPH, 'subject-logistica', () => false)).toEqual([
			'subject-almacen',
			'subject-ventas',
			'subject-vehiculos',
			'subject-logistica',
		]);
	});

	test('omite las que ya están listas pero recorre sus dependencias', () => {
		const ready = new Set(['subject-ventas']);
		expect(plan_subject_install(GRAPH, 'subject-logistica', (t) => ready.has(t))).toEqual([
			'subject-almacen',
			'subject-vehiculos',
			'subject-logistica',
		]);
	});

	test('el objetivo siempre va aunque ya esté instalado (reintento)', () => {
		expect(plan_subject_install(GRAPH, 'subject-almacen', () => true)).toEqual([
			'subject-almacen',
		]);
	});

	test('una app base nunca entra al plan como dependencia', () => {
		const graph = [...GRAPH, node('turnos', ['configuracion'])];
		expect(plan_subject_install(graph, 'subject-turnos', () => false)).toEqual([
			'subject-turnos',
		]);
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
