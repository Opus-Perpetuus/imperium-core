/**
 * One-shot geometry draft for subject logos. Not imported at runtime.
 * Run: bun modular/kit/src/icons/_draft-subject-glyphs.mjs
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

const P = (d) => `<path d="${d}"/>`;
const R = (x, y, w, h, rx) =>
	`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;
const C = (cx, cy, rad) => `<circle cx="${cx}" cy="${cy}" r="${rad}"/>`;

const GLYPHS = {
	almacen: P(
		roundedPolygon(
			[
				[8, 24],
				[32, 8],
				[56, 24],
				[56, 56],
				[8, 56],
			],
			3.5,
		) +
			rrect(15, 33, 13, 23, 3) +
			rrect(36, 33, 13, 23, 3) +
			rrect(29, 15, 6, 8, 1.4),
	),
	configuracion:
		P(circle(32, 32, 17.2) + circle(32, 32, 9.4)) +
		[0, 60, 120, 180, 240, 300]
			.map(
				(deg) =>
					`<rect x="27" y="5.5" width="10" height="13.5" rx="2.2" transform="rotate(${deg} 32 32)"/>`,
			)
			.join(''),
	'configuraciones-de-vista':
		R(8, 8, 22, 22, 4.5) +
		R(34, 8, 22, 22, 4.5) +
		R(8, 34, 22, 22, 4.5) +
		R(34, 34, 22, 22, 4.5),
	'control-hospitalario': P(roundedPlus(32, 32, 24, 8, 3.5)),
	'control-emergencias': P(
		roundedPolygon(
			[
				[32, 6],
				[58, 54],
				[6, 54],
			],
			5,
		) +
			rrect(29, 22, 6, 16, 2) +
			circle(32, 45.5, 3.2),
	),
	'control-escolar':
		P(
			roundedPolygon(
				[
					[6, 28],
					[32, 12],
					[58, 28],
					[32, 44],
				],
				2.4,
			),
		) +
		P('M20 45 C22 54 42 54 44 45 L32 52 Z') +
		R(58, 30, 4, 14, 1.5) +
		C(60, 48, 3.2),
	'control-municipal': P(
		roundedPolygon(
			[
				[10, 56],
				[10, 26],
				[32, 8],
				[54, 26],
				[54, 56],
			],
			2.8,
		) +
			rrect(16, 30, 8, 18, 1.6) +
			rrect(28, 30, 8, 26, 1.6) +
			rrect(40, 30, 8, 18, 1.6),
	),
	'dispositivos-fisicos':
		P(rrect(8, 8, 48, 34, 5) + rrect(12, 12, 40, 26, 2.5)) +
		R(28, 42, 8, 6, 1.6) +
		R(18, 48, 28, 6, 2.5),
	'facturacion-electronica': P(
		'M14 8 H37 L52 23 V54 A4 4 0 0 1 48 58 H14 A4 4 0 0 1 10 54 V12 A4 4 0 0 1 14 8 Z' +
			'M37 8 V23 H52 Z' +
			rrect(18, 32, 26, 4.5, 2.2) +
			rrect(18, 41, 20, 4.5, 2.2) +
			rrect(18, 50, 14, 4.5, 2.2),
	),
	logistica:
		P(rrect(6, 16, 34, 26, 3.5)) +
		P(rrect(38, 22, 20, 20, 3.5) + rrect(42, 26, 11, 8, 2)) +
		P(circle(16, 47, 7.2) + circle(16, 47, 2.8)) +
		P(circle(46, 47, 7.2) + circle(46, 47, 2.8)),
	pos:
		P(
			rrect(15, 6, 34, 38, 6) +
				rrect(19, 10, 26, 20, 3) +
				rrect(21, 34, 22, 3.6, 1.6),
		) + R(21, 48, 22, 10, 3.5),
	pagos: C(42, 26, 14.5) + C(23, 38, 14.5),
	rh:
		C(18, 14, 8) +
		R(5, 22, 26, 34, 13) +
		C(46, 14, 8) +
		R(33, 22, 26, 34, 13),
	reportes:
		R(10, 28, 12, 28, 3.2) +
		R(26, 12, 12, 44, 3.2) +
		R(42, 20, 12, 36, 3.2),
	planeacion: P(
		'M19 14 H24 V9 A3.5 3.5 0 0 1 27.5 5.5 H36.5 A3.5 3.5 0 0 1 40 9 V14 H45 A5 5 0 0 1 50 19 V53 A5 5 0 0 1 45 58 H19 A5 5 0 0 1 14 53 V19 A5 5 0 0 1 19 14 Z' +
			rrect(20, 28, 24, 24, 3.2) +
			'M26 41 L30.2 45.4 L40.2 33.2 L37.2 30.6 L30.2 39.4 L28.4 37.6 Z',
	),
	'tableros-dinamicos':
		R(8, 8, 22, 28, 4.5) +
		R(34, 8, 22, 16, 4.5) +
		R(8, 40, 22, 16, 4.5) +
		R(34, 28, 22, 28, 4.5),
	turnos: P(
		circle(32, 32, 26) +
			circle(32, 32, 19.2) +
			rrect(30, 16, 4, 17, 2) +
			'M32 32 L44 40.2 L41.4 43.8 L29.2 34.6 Z',
	),
	vehiculos:
		P(
			'M8 38 C10 28 16 18 30 16 H42 C50 16 54 22 56 30 L58 38 V42 H8 Z' +
				rrect(20, 20, 26, 12, 2.4),
		) +
		P(circle(18, 47, 7.2) + circle(18, 47, 2.8)) +
		P(circle(48, 47, 7.2) + circle(48, 47, 2.8)),
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
<title>Logo Preview — Subject marks</title>
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
    <h1>Subject logos — draft</h1>
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

import { mkdirSync, writeFileSync } from 'node:fs';
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
writeFileSync(
	join(
		repo,
		'frontend/src/app/components/module-management/subject-logo-glyphs.json',
	),
	JSON.stringify(GLYPHS, null, '\t') + '\n',
);
console.log('wrote', Object.keys(GLYPHS).length, 'glyphs + preview + json');
