import { describe, expect, test } from 'bun:test';
import catalog from '../../../catalog.json';
import {
	SUBJECT_SLUGS,
	is_subject_logo_ref,
	resolve_subject_logo,
	subject_logo_ref,
	subject_logo_svg,
} from './subject-logos.ts';

describe('subject SVG logo registry', () => {
	test('every catalog L1 slug resolves to an SVG', () => {
		const slugs = (
			catalog as { subjects: Array<{ slug: string }> }
		).subjects.map((s) => s.slug);
		expect(slugs.length).toBe(20);
		for (const slug of slugs) {
			expect(
				SUBJECT_SLUGS.includes(slug as (typeof SUBJECT_SLUGS)[number]),
			).toBe(true);
			const svg = resolve_subject_logo(subject_logo_ref(slug));
			expect(svg).toBeTruthy();
			expect(String(svg)).toContain('<svg');
			expect(String(svg)).toContain('</svg>');
			expect(is_subject_logo_ref(subject_logo_ref(slug))).toBe(true);
			expect(subject_logo_svg(slug)).toContain('<svg');
		}
	});

	test('theme-adaptive gradient, no hex, distinct glyphs', () => {
		const glyph_key = (svg: string) =>
			svg
				.replace(/id="subject-grad-[^"]+"/g, 'id="G"')
				.replace(/url\(#subject-grad-[^)]+\)/g, 'url(#G)');
		const rendered = SUBJECT_SLUGS.map((slug) => subject_logo_svg(slug));
		expect(new Set(rendered.map(glyph_key)).size).toBe(SUBJECT_SLUGS.length);
		for (const svg of rendered) {
			expect(svg).toContain('linearGradient');
			expect(svg).toContain('var(--imperium-primary)');
			expect(svg).toContain('var(--imperium-primary-alt)');
			expect(svg).toContain('viewBox="0 0 64 64"');
			expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}/);
		}
	});

	test('frontend glyph map stays in sync with kit json', async () => {
		const { readFileSync } = await import('node:fs');
		const { dirname, join } = await import('node:path');
		const { fileURLToPath } = await import('node:url');
		const here = dirname(fileURLToPath(import.meta.url));
		const json = JSON.parse(
			readFileSync(join(here, 'subject-logo-glyphs.json'), 'utf8'),
		) as Record<string, string>;
		const frontend = readFileSync(
			join(
				here,
				'../../../../frontend/src/app/components/module-management/subject-logo-glyphs.ts',
			),
			'utf8',
		);
		for (const [slug, inner] of Object.entries(json)) {
			expect(frontend).toContain(inner);
			expect(subject_logo_svg(slug)).toContain(inner);
		}
	});

	test('each wrap uses a local gradient id so a hidden twin cannot steal the paint', () => {
		const first = subject_logo_svg('almacen');
		const second = subject_logo_svg('almacen');
		const id_of = (svg: string) => {
			const match = svg.match(/id="(subject-grad-[^"]+)"/);
			expect(match?.[1]).toBeTruthy();
			return match![1];
		};
		const first_id = id_of(first);
		const second_id = id_of(second);
		expect(first_id).not.toBe(second_id);
		expect(first).toContain(`url(#${first_id})`);
		expect(second).toContain(`url(#${second_id})`);
		expect(first).not.toContain(`url(#${second_id})`);
		expect(second).not.toContain(`url(#${first_id})`);
	});

	test('frontend wrap unique-ifies paint-server ids like the kit', async () => {
		const { readFileSync } = await import('node:fs');
		const { dirname, join } = await import('node:path');
		const { fileURLToPath } = await import('node:url');
		const here = dirname(fileURLToPath(import.meta.url));
		const frontend = readFileSync(
			join(
				here,
				'../../../../frontend/src/app/components/module-management/subject-logo-glyphs.ts',
			),
			'utf8',
		);
		expect(frontend).toMatch(/let logo_instance = 0/);
		expect(frontend).toMatch(/subject-grad-\$\{safe\}-\$\{/);
	});

	test('mobile header chrome mounts the subject mark and unhides it at the phone breakpoint', async () => {
		const { readFileSync } = await import('node:fs');
		const { dirname, join } = await import('node:path');
		const { fileURLToPath } = await import('node:url');
		const here = dirname(fileURLToPath(import.meta.url));
		const frontend = join(here, '../../../../frontend/src/app');
		const html = readFileSync(
			join(frontend, 'shared/header/header.component.html'),
			'utf8',
		);
		const css = readFileSync(
			join(frontend, 'shared/header/header.component.css'),
			'utf8',
		);
		const mobile_brand = html.match(
			/class="header-mobile-brand[\s\S]*?(?=<div\s+class="header-mobile-doc-bar"|@if \(is_tablet_layout)/,
		)?.[0];
		expect(mobile_brand).toBeTruthy();
		expect(mobile_brand).toContain('imperium-subject-brand-mark');
		expect(mobile_brand).toContain('[show_name]="false"');
		expect(css).toMatch(
			/@media \(max-width: 991px\)[\s\S]*?\.header-mobile-brand\s*\{[\s\S]*?display:\s*grid/,
		);
		const phone_block = css.slice(css.lastIndexOf('@media (max-width: 991px)'));
		const logo_rule = phone_block.match(
			/\.header-mobile-brand__logo(?:,\s*\.header-mobile-brand__toggle)?\s*\{[^}]+\}/,
		)?.[0];
		expect(logo_rule).toBeTruthy();
		expect(logo_rule).not.toMatch(/display:\s*none/);
	});
});
