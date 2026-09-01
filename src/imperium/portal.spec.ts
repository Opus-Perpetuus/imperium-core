import { describe, expect, test } from 'bun:test';
import {
	apply_landing_code,
	default_home_document,
	sanitize_nox_html,
	type NoxHtmlPurifier,
} from '@opus-perpetuus/imperium-core-kit';
import DOMPurify from 'isomorphic-dompurify';
import {
	create_memory_portal_store,
	ensure_home,
	get_draft,
	get_published,
	handle_portal_request,
	is_anonymous_portal_read,
	portal_route_path,
	publish_home,
	put_draft,
	type PortalPageStore,
} from './portal.ts';

const purifier = DOMPurify as unknown as NoxHtmlPurifier;
const sanitize = (html: string) => sanitize_nox_html(html, purifier);

function store(): PortalPageStore {
	return create_memory_portal_store();
}

describe('portal persist', () => {
	test('fresh install publishes a non-empty default home', async () => {
		const pages = store();
		await ensure_home(pages, sanitize);
		const published = await get_published(pages, 'home');
		expect(published).not.toBeNull();
		expect(published?.['id']).toBeTruthy();
		expect(published?.['title']).toBeTruthy();
		const page = published?.['page'] as {
			component?: string;
			children?: unknown[];
		};
		expect(page?.component).toBe('nox.page');
		expect((page?.children ?? []).length).toBeGreaterThan(0);
		expect(published?.['email']).toBeUndefined();
		expect(published?.['password']).toBeUndefined();
	});

	test('draft replace does not become public until publish', async () => {
		const pages = store();
		await ensure_home(pages, sanitize);
		const before = await get_published(pages, 'home');
		const next = apply_landing_code(
			JSON.stringify({
				id: 'portal.home',
				owner: 'portal',
				title: 'Borrador',
				page: {
					component: 'nox.page',
					children: [{ component: 'nox.wizard', props: { steps: [] } }],
				},
			}),
		);
		expect(next.ok).toBe(true);
		if (!next.ok) return;
		const saved = await put_draft(pages, 'home', next.document, sanitize);
		expect(saved.ok).toBe(true);
		const still = await get_published(pages, 'home');
		expect(still?.['title']).toBe(before?.['title']);
		expect(still?.['title']).not.toBe('Borrador');
		const published = await publish_home(pages, 'home', 'tester', sanitize);
		expect(published.ok).toBe(true);
		if (!published.ok) return;
		expect(published.document['title']).toBe('Borrador');
		expect((await get_published(pages, 'home'))?.['title']).toBe('Borrador');
	});

	test('invalid JSON / unknown id do not replace the last good document', async () => {
		const pages = store();
		await ensure_home(pages, sanitize);
		const before = await get_draft(pages, 'home');
		const bad_json = await put_draft(
			pages,
			'home',
			'{ not json' as unknown as Record<string, unknown>,
			sanitize,
		);
		expect(bad_json.ok).toBe(false);
		const bad_id = await put_draft(
			pages,
			'home',
			{
				id: 'portal.home',
				owner: 'portal',
				title: 'X',
				page: {
					component: 'nox.page',
					children: [{ component: 'evil.widget' }],
				},
			},
			sanitize,
		);
		expect(bad_id.ok).toBe(false);
		const after = await get_draft(pages, 'home');
		expect(after?.draft).toEqual(before?.draft);
		expect((await get_published(pages, 'home'))?.['id']).toBe(
			default_home_document()['id'],
		);
	});

	test('hostile HTML is stripped on persist', async () => {
		const pages = store();
		await ensure_home(pages, sanitize);
		const saved = await put_draft(
			pages,
			'home',
			{
				id: 'portal.home',
				owner: 'portal',
				title: 'Inicio',
				page: {
					component: 'nox.page',
					children: [
						{
							component: 'nox.html',
							props: { html: '<script>alert(1)</script><p>ok</p>' },
						},
					],
				},
			},
			sanitize,
		);
		expect(saved.ok).toBe(true);
		if (!saved.ok) return;
		const html = (
			(saved.draft['page'] as { children: Array<{ props: { html: string } }> })
				.children[0]!.props.html
		);
		expect(html).not.toContain('script');
		expect(html).toContain('ok');
	});
});

describe('portal public GET', () => {
	test('the public API path is /api/p/portal/pages/home, not login', () => {
		expect(portal_route_path('/api/p/portal/pages/home')).toBe(
			'/p/portal/pages/home',
		);
		expect(portal_route_path('/login')).toBeNull();
		expect(portal_route_path('/api/auth/login')).toBeNull();
		expect(portal_route_path('/internal')).toBeNull();
		expect(
			is_anonymous_portal_read(
				new Request('http://imperium.test/api/p/portal/pages/home'),
			),
		).toBe(true);
		expect(
			is_anonymous_portal_read(
				new Request('http://imperium.test/api/portal/pages/home/draft', {
					method: 'PUT',
				}),
			),
		).toBe(false);
	});

	test('unauthenticated GET returns the published page descriptor', async () => {
		const pages = store();
		await ensure_home(pages, sanitize);
		const once = async () => {
			const res = await handle_portal_request(
				new Request('http://imperium.test/api/p/portal/pages/home'),
				{ store: pages, sanitize, actor: null },
			);
			expect(res).not.toBeNull();
			expect(res!.status).toBe(200);
			const body = (await res!.json()) as Record<string, unknown>;
			expect(body['id']).toBeTruthy();
			expect(body['title']).toBeTruthy();
			const page = body['page'] as {
				component?: string;
				children?: unknown[];
			};
			expect(page?.component).toBe('nox.page');
			expect((page?.children ?? []).length).toBeGreaterThan(0);
			expect(body['email']).toBeUndefined();
			expect(body['password']).toBeUndefined();
			return body;
		};
		const first = await once();
		const second = await once();
		expect(second['id']).toBe(first['id']);
	});

	test('draft PUT without auth is rejected and does not publish', async () => {
		const pages = store();
		await ensure_home(pages, sanitize);
		const res = await handle_portal_request(
			new Request('http://imperium.test/api/portal/pages/home/draft', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					document: {
						id: 'portal.home',
						owner: 'portal',
						title: 'Hack',
						page: { component: 'nox.page', children: [] },
					},
				}),
			}),
			{ store: pages, sanitize, actor: null },
		);
		expect(res?.status).toBe(401);
		expect((await get_published(pages, 'home'))?.['title']).not.toBe('Hack');
	});
});
