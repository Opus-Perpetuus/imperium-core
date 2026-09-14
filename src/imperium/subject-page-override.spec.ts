import { describe, expect, test } from 'bun:test';
import {
	APP_CONTENT_BLOCK,
	default_subject_override,
	merge_subject_page,
	subject_override_slug,
} from './subject-page-override.ts';

const app_page = {
	id: 'tienda.store.home',
	owner: 'subject-tienda',
	title: 'Tienda',
	page: {
		component: 'nox.stack',
		props: { gap: 'md' },
		children: [{ component: 'nox.catalog-grid', props: { items: [1, 2] } }],
	},
};

function slot() {
	return { component: 'nox.stack', props: { block: APP_CONTENT_BLOCK } };
}

describe('clave de una personalización', () => {
	test('cada página de cada app tiene la suya', () => {
		expect(subject_override_slug('subject-tienda', 'tienda.store.home')).toBe(
			'app:subject-tienda:tienda.store.home',
		);
		expect(subject_override_slug('subject-rh', 'rh.portal.vacantes')).not.toBe(
			subject_override_slug('subject-tienda', 'rh.portal.vacantes'),
		);
	});
});

describe('mezcla de la personalización con la página de la app', () => {
	test('sin personalización la página de la app pasa intacta', () => {
		expect(merge_subject_page(app_page, null)).toEqual(app_page);
		expect(merge_subject_page(app_page, {})).toEqual(app_page);
	});

	test('lo que escribe el usuario rodea a la app, nunca la sustituye', () => {
		// La página de una app es dinámica: su rejilla se arma con los productos
		// de este momento. Una personalización que la sustituyera congelaría el
		// catálogo en lo que hubiera el día que se publicó.
		const merged = merge_subject_page(app_page, {
			page: {
				component: 'nox.stack',
				children: [
					{ component: 'nox.markdown-view', props: { content: '# Promo' } },
					slot(),
					{ component: 'nox.markdown-view', props: { content: 'Pie' } },
				],
			},
		}) as { page: { children: Array<Record<string, unknown>> } };

		const kids = merged.page.children;
		expect(kids).toHaveLength(3);
		expect(kids[0]!['component']).toBe('nox.markdown-view');
		expect(kids[2]!['component']).toBe('nox.markdown-view');
		// El hueco quedó relleno con el árbol vivo de la app.
		const hueco = kids[1] as { children: unknown[] };
		expect(hueco.children).toEqual([app_page.page]);
	});

	test('una personalización sin hueco no pierde la página de la app', () => {
		// Si alguien borra el marcador desde el editor, la app se añade al final
		// antes que desaparecer: una tienda sin catálogo no es una opción.
		const merged = merge_subject_page(app_page, {
			page: {
				component: 'nox.stack',
				children: [
					{ component: 'nox.markdown-view', props: { content: 'Solo esto' } },
				],
			},
		}) as { page: { children: unknown[] } };
		expect(merged.page.children).toHaveLength(2);
		expect(merged.page.children[1]).toEqual(app_page.page);
	});

	test('el título sigue siendo el de la app, no el del marco', () => {
		// El descriptor guardado necesita un título para validar, y el editor
		// pone uno por defecto. Si se tomara de ahí, personalizar el catálogo lo
		// dejaría titulado «Inicio» para todos los visitantes.
		const merged = merge_subject_page(app_page, {
			title: 'Inicio',
			page: { component: 'nox.stack', children: [slot()] },
		}) as { title: string };
		expect(merged.title).toBe('Tienda');
	});

	test('el hueco se rellena aunque esté anidado', () => {
		const merged = merge_subject_page(app_page, {
			page: {
				component: 'nox.stack',
				children: [
					{ component: 'nox.card', props: { title: 'X' }, children: [slot()] },
				],
			},
		}) as { page: { children: Array<{ children: Array<{ children: unknown[] }> }> } };
		expect(merged.page.children[0]!.children[0]!.children).toEqual([
			app_page.page,
		]);
	});

	test('la identidad de la página sigue siendo la de la app', () => {
		const merged = merge_subject_page(app_page, {
			id: 'otra',
			owner: 'intruso',
			title: 'T',
			page: { component: 'nox.stack', children: [slot()] },
		}) as Record<string, unknown>;
		expect(merged['id']).toBe('tienda.store.home');
		expect(merged['owner']).toBe('subject-tienda');
	});

	test('una personalización rota deja pasar la página de la app', () => {
		expect(merge_subject_page(app_page, { page: 'no es un nodo' })).toEqual(
			app_page,
		);
		expect(merge_subject_page(app_page, { page: null })).toEqual(app_page);
	});
});

describe('personalización de arranque', () => {
	test('trae el hueco ya puesto, para que se vea la app desde el minuto uno', () => {
		const doc = default_subject_override('Catálogo') as {
			title: string;
			page: { children: Array<{ props: Record<string, unknown> }> };
		};
		expect(doc.title).toBe('Catálogo');
		const blocks = doc.page.children.map((c) => c.props?.['block']);
		expect(blocks).toContain(APP_CONTENT_BLOCK);
	});

	test('mezclada consigo misma enseña la app', () => {
		const merged = merge_subject_page(
			app_page,
			default_subject_override('Tienda'),
		) as { page: { children: unknown[] } };
		const json = JSON.stringify(merged);
		expect(json).toContain('nox.catalog-grid');
	});
});
