/**
 * Authoring source for subject catalog logos (64×64 filled marks).
 * Run: bun modular/kit/src/icons/subject-logo-geometry.mjs
 * See docs/subject-logos/README.md
 * Principios: docs/subject-logos/pictogram-principles.md
 */
const r2 = (n) => Math.round(n * 100) / 100;

function polar(cx, cy, rad, deg) {
	const a = (deg * Math.PI) / 180;
	return [r2(cx + rad * Math.cos(a)), r2(cy + rad * Math.sin(a))];
}

function rrect(x, y, w, h, r) {
	r = Math.min(r, w / 2, h / 2);
	const x2 = x + w;
	const y2 = y + h;
	return `M${r2(x + r)} ${r2(y)}H${r2(x2 - r)}A${r} ${r} 0 0 1 ${r2(x2)} ${r2(y + r)}V${r2(y2 - r)}A${r} ${r} 0 0 1 ${r2(x2 - r)} ${r2(y2)}H${r2(x + r)}A${r} ${r} 0 0 1 ${r2(x)} ${r2(y2 - r)}V${r2(y + r)}A${r} ${r} 0 0 1 ${r2(x + r)} ${r2(y)}Z`;
}

function circle(cx, cy, rad) {
	return `M${r2(cx - rad)} ${r2(cy)}A${rad} ${rad} 0 1 0 ${r2(cx + rad)} ${r2(cy)}A${rad} ${rad} 0 1 0 ${r2(cx - rad)} ${r2(cy)}Z`;
}

function roundedPolygon(pts, radius) {
	const n = pts.length;
	const norm = (x, y) => {
		const l = Math.hypot(x, y) || 1;
		return [x / l, y / l];
	};
	let d = '';
	for (let i = 0; i < n; i++) {
		const prev = pts[(i + n - 1) % n];
		const curr = pts[i];
		const next = pts[(i + 1) % n];
		const [u1x, u1y] = norm(prev[0] - curr[0], prev[1] - curr[1]);
		const [u2x, u2y] = norm(next[0] - curr[0], next[1] - curr[1]);
		const p1 = [curr[0] + u1x * radius, curr[1] + u1y * radius];
		const p2 = [curr[0] + u2x * radius, curr[1] + u2y * radius];
		if (i === 0) d += `M${r2(p1[0])} ${r2(p1[1])}`;
		else d += `L${r2(p1[0])} ${r2(p1[1])}`;
		d += `Q${r2(curr[0])} ${r2(curr[1])} ${r2(p2[0])} ${r2(p2[1])}`;
	}
	return d + 'Z';
}

function gear({
	teeth = 6,
	cx = 32,
	cy = 32,
	rTip = 25.5,
	rRoot = 18,
	rHole = 9.4,
	tipRatio = 0.4,
	tipR = 2.6,
}) {
	const pitch = 360 / teeth;
	const halfTip = (pitch * tipRatio) / 2;
	let d = '';
	for (let i = 0; i < teeth; i++) {
		const mid = -90 + i * pitch;
		const [x0, y0] = polar(cx, cy, rRoot, mid - pitch / 2);
		const [x1, y1] = polar(cx, cy, rTip, mid - halfTip);
		const [x2, y2] = polar(cx, cy, rTip, mid + halfTip);
		d += i === 0 ? `M${x0} ${y0}` : `L${x0} ${y0}`;
		d += `L${x1} ${y1}A${tipR} ${tipR} 0 0 1 ${x2} ${y2}`;
	}
	return d + 'Z' + circle(cx, cy, rHole);
}

function roundedPlus(cx, cy, arm, bar, rad) {
	const T = cy - arm;
	const B = cy + arm;
	const L = cx - arm;
	const R = cx + arm;
	const it = cy - bar;
	const ib = cy + bar;
	const il = cx - bar;
	const ir = cx + bar;
	return [
		`M${r2(il + rad)} ${r2(T)}`,
		`H${r2(ir - rad)}`,
		`A${rad} ${rad} 0 0 1 ${r2(ir)} ${r2(T + rad)}`,
		`V${r2(it)}`,
		`H${r2(R - rad)}`,
		`A${rad} ${rad} 0 0 1 ${r2(R)} ${r2(it + rad)}`,
		`V${r2(ib - rad)}`,
		`A${rad} ${rad} 0 0 1 ${r2(R - rad)} ${r2(ib)}`,
		`H${r2(ir)}`,
		`V${r2(B - rad)}`,
		`A${rad} ${rad} 0 0 1 ${r2(ir - rad)} ${r2(B)}`,
		`H${r2(il + rad)}`,
		`A${rad} ${rad} 0 0 1 ${r2(il)} ${r2(B - rad)}`,
		`V${r2(ib)}`,
		`H${r2(L + rad)}`,
		`A${rad} ${rad} 0 0 1 ${r2(L)} ${r2(ib - rad)}`,
		`V${r2(it + rad)}`,
		`A${rad} ${rad} 0 0 1 ${r2(L + rad)} ${r2(it)}`,
		`H${r2(il)}`,
		`V${r2(T + rad)}`,
		`A${rad} ${rad} 0 0 1 ${r2(il + rad)} ${r2(T)}`,
		'Z',
	].join('');
}

const CUTOUT = 5;

function wheel(cx, cy, r = 7.4, hub = 3) {
	return P(circle(cx, cy, r) + circle(cx, cy, hub));
}

function rrectOutset(x, y, w, h, r, pad = CUTOUT) {
	return rrect(x - pad, y - pad, w + 2 * pad, h + 2 * pad, r + pad);
}

function person(cx, yTop) {
	const hr = 7.4;
	const headCy = yTop + hr;
	const bodyY = headCy + hr + 1.6;
	return circle(cx, headCy, hr) + rrect(cx - 12, bodyY, 24, 28, 11);
}

function personOutset(cx, yTop, pad = CUTOUT) {
	const hr = 7.4;
	const headCy = yTop + hr;
	const bodyY = headCy + hr + 1.6;
	return (
		circle(cx, headCy, hr + pad) +
		rrect(cx - 12 - pad, bodyY - pad, 24 + 2 * pad, 28 + 2 * pad, 11 + pad)
	);
}

const P = (d) => `<path d="${d}"/>`;
const R = (x, y, w, h, rx) =>
	`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;
const C = (cx, cy, rad) => `<circle cx="${cx}" cy="${cy}" r="${rad}"/>`;

const GLYPHS = {
	almacen:
		P(
			rrect(20, 8, 36, 26, 3.5) +
				rrect(30, 15, 16, 5, 1.8) +
				rrectOutset(8, 30, 36, 26, 3.5),
		) + P(rrect(8, 30, 36, 26, 3.5) + rrect(18, 38, 16, 5, 1.8)),
	configuracion: P(
		gear({
			teeth: 8,
			rTip: 26,
			rRoot: 18,
			rHole: 9.2,
			tipRatio: 0.36,
			tipR: 2.4,
		}),
	),
	'configuraciones-de-vista': P(
		rrect(8, 8, 48, 48, 4.5) +
			rrect(12, 12, 15, 40, 2.5) +
			rrect(32, 12, 20, 17, 2.5) +
			rrect(32, 34, 20, 18, 2.5),
	),
	'control-hospitalario': P(
		circle(32, 32, 26) + roundedPlus(32, 32, 15, 5.5, 2.5),
	),
	'control-emergencias': P(
		roundedPolygon(
			[
				[32, 6],
				[58, 54],
				[6, 54],
			],
			5,
		) +
			rrect(29, 21, 6, 17, 2) +
			circle(32, 45.5, 3.4),
	),
	'control-escolar':
		P(
			roundedPolygon(
				[
					[32, 8],
					[58, 26],
					[32, 38],
					[6, 26],
				],
				2.6,
			),
		) +
		R(50, 26, 5.2, 16, 2.4) +
		C(52.6, 46, 4.6),
	'control-municipal':
		P(
			rrect(8, 26, 48, 30, 3.2) +
				rrect(12, 32, 8, 10, 1.8) +
				rrect(27, 38, 10, 12, 2) +
				rrect(44, 32, 8, 10, 1.8),
		) +
		P(
			roundedPolygon(
				[
					[22, 14],
					[32, 6],
					[42, 14],
				],
				2.2,
			),
		) +
		P(rrect(24, 12, 16, 16, 2.5) + circle(32, 18, 4)),
	'dispositivos-fisicos':
		P(rrect(8, 8, 48, 34, 5) + rrect(12, 12, 40, 26, 2.5)) +
		R(28, 42, 8, 6, 1.6) +
		R(18, 48, 28, 6, 2.5),
	'facturacion-electronica': P(
		'M14 8 H36 L52 24 V54 A4 4 0 0 1 48 58 H14 A4 4 0 0 1 10 54 V12 A4 4 0 0 1 14 8 Z' +
			rrect(16, 30, 24, 5, 2.2) +
			rrect(16, 39, 20, 5, 2.2) +
			rrect(16, 48, 14, 5, 2.2),
	),
	logistica:
		P(rrect(6, 12, 34, 30, 3.5) + circle(16, 47, 7.4)) +
		P(
			rrect(38, 20, 20, 22, 3.5) +
				rrect(42, 24, 12, 9, 2) +
				circle(48, 47, 7.4),
		) +
		wheel(16, 47) +
		wheel(48, 47),
	pos:
		P(
			rrect(15, 6, 34, 38, 6) +
				rrect(19, 10, 26, 20, 3) +
				rrect(21, 34, 22, 3.6, 1.6),
		) + R(21, 48, 22, 10, 3.5),
	pagos: P(
		rrect(6, 16, 52, 32, 5) +
			rrect(10, 22, 44, 7, 1.5) +
			rrect(12, 36, 11, 8, 1.8),
	),
	rh: P(person(18, 8) + personOutset(40, 8)) + P(person(40, 8)),
	reportes:
		R(10, 30, 11, 26, 3) +
		R(26.5, 14, 11, 42, 3) +
		R(43, 22, 11, 34, 3) +
		R(8, 51, 48, 5, 2),
	planeacion:
		P(
			rrect(12, 10, 40, 46, 4.5) +
				rrect(17, 22, 30, 7, 2) +
				rrect(17, 33, 30, 5, 2) +
				rrect(17, 42, 22, 5, 2),
		) +
		R(20, 6, 7, 11, 2.5) +
		R(37, 6, 7, 11, 2.5),
	'tableros-dinamicos':
		R(8, 8, 22, 28, 4) +
		R(35, 8, 21, 16, 4) +
		R(8, 41, 22, 15, 4) +
		R(35, 29, 21, 27, 4),
	turnos:
		P(circle(32, 32, 26) + circle(32, 32, 18.4)) +
		R(29.8, 15, 4.4, 18.5, 2.1) +
		P('M32 32 L45 40.6 L42 44.2 L28.8 34.6 Z'),
	vehiculos:
		P(
			'M8 42C8 36 10 30 16 26L22 18C24 14 27 13 30 13H46C50 13 53 16 55 22L58 34V42H8Z' +
				rrect(28, 16, 20, 10, 2.2) +
				circle(18, 46.5, 7.4) +
				circle(47, 46.5, 7.4),
		) +
		wheel(18, 46.5) +
		wheel(47, 46.5),
	ventas: P(
		roundedPolygon(
			[
				[15, 22],
				[49, 22],
				[53, 56],
				[11, 56],
			],
			4.5,
		) +
			'M24 22 V14.5 A8 8 0 0 1 40 14.5 V22 H34.5 V15 A2.5 2.5 0 0 0 29.5 15 V22 Z',
	),
	tienda:
		P(
			roundedPolygon(
				[
					[8, 14],
					[56, 14],
					[60, 24],
					[4, 24],
				],
				2.4,
			),
		) +
		P(
			rrect(8, 24, 48, 32, 3.2) +
				rrect(26, 38, 12, 18, 2) +
				rrect(13, 30, 10, 8, 1.8) +
				rrect(41, 30, 10, 8, 1.8),
		),
};

function wrap(slug, inner) {
	const safe = slug.replace(/[^a-z0-9-]/g, '') || 'x';
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-hidden="true"><defs><linearGradient id="subject-grad-${safe}" x1="32" y1="4" x2="32" y2="60" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7d9cf8"/><stop offset="0.45" stop-color="#68b0ea"/><stop offset="1" stop-color="#54c4db"/></linearGradient></defs><g fill="url(#subject-grad-${safe})" fill-rule="evenodd">${inner}</g></svg>`;
}

const labels = {
	almacen: 'Almacén',
	configuracion: 'Configuración',
	'configuraciones-de-vista': 'Configuraciones de vista',
	'control-hospitalario': 'Control hospitalario',
	'control-emergencias': 'Control de emergencias',
	'control-escolar': 'Control escolar',
	'control-municipal': 'Control municipal',
	'dispositivos-fisicos': 'Dispositivos físicos',
	'facturacion-electronica': 'Facturación electrónica',
	logistica: 'Logística',
	pos: 'POS',
	pagos: 'Pagos',
	rh: 'RH',
	reportes: 'Reportes',
	planeacion: 'Soporte y planeación',
	'tableros-dinamicos': 'Tableros dinámicos',
	turnos: 'Turnos',
	vehiculos: 'Vehículos',
	ventas: 'Ventas',
	tienda: 'Tienda',
};

const cards = Object.entries(GLYPHS)
	.map(
		([slug, inner]) => `<div class="card">
  <div class="card-img">${wrap(slug, inner)}</div>
  <div class="card-label">${labels[slug]} <code>${slug}</code></div>
</div>`,
	)
	.join('\n');

const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Logos de apps</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem; }
  body.light { background: #f5f5f5; color: #333; }
  body.dark { background: #1a1a1a; color: #eee; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
  h1 { font-size: 1.5rem; font-weight: 600; }
  .toggle { padding: 0.5rem 1rem; border: 1px solid currentColor; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1.25rem; }
  .card { border: 1px solid rgba(128,128,128,0.3); border-radius: 12px; overflow: hidden; }
  .card-img { display: flex; align-items: center; justify-content: center; padding: 1.5rem; min-height: 180px; }
  .card-img svg { width: 96px; height: 96px; }
  body.light .card-img { background: #fff; }
  body.dark .card-img { background: #2a2a2a; }
  .card-label { padding: 0.75rem 1rem; font-size: 0.875rem; font-weight: 500; border-top: 1px solid rgba(128,128,128,0.3); }
  .card-label code { display: block; font-size: 0.7rem; opacity: 0.6; font-weight: 400; }
  body.light .card-label { background: #fafafa; }
  body.dark .card-label { background: #222; }
  .sizes { margin-top: 2.5rem; }
  .sizes h2 { font-size: 1.1rem; margin-bottom: 1rem; }
  .size-row { display: flex; gap: 2rem; flex-wrap: wrap; align-items: end; }
  .size-item { display: flex; flex-direction: column; align-items: center; gap: 0.4rem; }
  .size-item span { font-size: 0.7rem; opacity: 0.6; }
</style>
</head>
<body class="light">
  <div class="header">
    <h1>Logos de apps</h1>
    <button class="toggle" onclick="document.body.classList.toggle('dark'); document.body.classList.toggle('light'); this.textContent = document.body.classList.contains('dark') ? '☀️ Light' : '🌙 Dark';">🌙 Dark</button>
  </div>
  <div class="grid">
${cards}
  </div>
  <div class="sizes">
    <h2>Legibilidad 64 / 32 / 16</h2>
    <div class="size-row">
      ${Object.entries(GLYPHS)
			.map(
				([slug, inner]) => `<div class="size-item">
        <div style="display:flex;gap:12px;align-items:end">
          <div>${wrap(slug + '-64', inner).replace('viewBox', 'width="64" height="64" viewBox')}</div>
          <div>${wrap(slug + '-32', inner).replace('viewBox', 'width="32" height="32" viewBox')}</div>
          <div>${wrap(slug + '-16', inner).replace('viewBox', 'width="16" height="16" viewBox')}</div>
        </div>
        <span>${slug}</span>
      </div>`,
			)
			.join('\n')}
    </div>
  </div>
</body>
</html>
`;

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../../..');
const outDir = join(repo, 'docs/subject-logos');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'preview.html'), html);
writeFileSync(
	join(here, 'subject-logo-glyphs.json'),
	JSON.stringify(GLYPHS, null, '\t') + '\n',
);

const fe_path = join(
	repo,
	'frontend/src/app/components/module-management/subject-logo-glyphs.ts',
);
const fe_lines = Object.entries(GLYPHS).map(([k, v]) => {
	const key = k.includes('-') ? `'${k}'` : k;
	return `    ${key}: '${v}',`;
});
const fe_block =
	'export const SUBJECT_GLYPHS: Record<string, string> = {\n' +
	fe_lines.join('\n') +
	'\n};\n';
const fe_src = readFileSync(fe_path, 'utf8');
const fe_start = fe_src.indexOf(
	'export const SUBJECT_GLYPHS: Record<string, string> = {',
);
const fe_end = fe_src.indexOf('\nexport const SUBJECT_LOGO_SLUGS', fe_start);
if (fe_start < 0 || fe_end < 0)
	throw new Error('frontend SUBJECT_GLYPHS block not found');
const fe_next = fe_src.slice(0, fe_start) + fe_block + fe_src.slice(fe_end);
writeFileSync(fe_path, fe_next);
console.log(
	'wrote',
	Object.keys(GLYPHS).length,
	'glyphs + preview + kit json + frontend ts',
);
