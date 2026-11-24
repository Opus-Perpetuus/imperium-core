/**
 * Reporte de hardware de dispositivos (#336): qué es «cambio del equipo» y qué
 * es dato volátil. Un reporte sin cambio de hardware solo toca la fecha de
 * última revisión y los volátiles, sin historial ni notificaciones.
 */
import { createHash } from 'node:crypto';

type Doc = Record<string, unknown>;

/**
 * Llaves volátiles en cualquier nivel del snapshot (sin distinguir mayúsculas):
 * memoria libre/usada, batería, carga, uptime, red (IP/DHCP/velocidad),
 * navigator.online, uso de discos (#335) y sellos de tiempo.
 */
export const PHYSICAL_DEVICE_VOLATILE_KEYS: ReadonlySet<string> = new Set(
	[
		'free', 'used', 'available', 'active', 'buffcache', 'buffers', 'cached', 'slab',
		'swapused', 'swapfree', 'battery', 'percent', 'ischarging', 'currentcapacity',
		'uptime', 'currentload', 'load', 'avgload', 'online', 'network', 'ip4', 'ip6',
		'ip4subnet', 'ip6subnet', 'dhcp', 'speed', 'operstate', 'use', 'rx_bytes',
		'tx_bytes', 'temperature', 'timestamp', 'time', 'generated_at', 'reported_at',
		'collected_at', 'last_seen', 'processes',
	].map((k) => k.toLowerCase()),
);

/** Campos del documento que cambian sin que cambie el equipo. */
export const PHYSICAL_DEVICE_VOLATILE_FIELDS = [
	'last_seen',
	'last_user_id',
	'last_user_name',
	'primary_ip4',
	'disk_free_bytes',
] as const;

/** Campos estables promovidos a columna que entran a la huella. */
const STABLE_FIELDS = [
	'name', 'install_uuid', 'machine_uuid', 'hostname', 'manufacturer', 'model', 'serial',
	'os_platform', 'os_distro', 'os_release', 'os_arch', 'cpu_brand', 'cpu_cores',
	'memory_total_bytes', 'gpu_primary', 'primary_mac', 'device_kind', 'app_version', 'is_active',
] as const;

/** Snapshot sin volátiles (recursivo). */
export function stable_snapshot(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => stable_snapshot(item));
	if (!value || typeof value !== 'object') return value;
	const out: Doc = {};
	for (const [key, item] of Object.entries(value as Doc)) {
		if (PHYSICAL_DEVICE_VOLATILE_KEYS.has(key.toLowerCase())) continue;
		out[key] = stable_snapshot(item);
	}
	return out;
}

/** JSON con llaves ordenadas (al estilo RFC 8785) para comparar sin importar el orden. */
export function canonical_json(value: unknown): string {
	if (value === undefined) return 'null';
	if (Array.isArray(value)) return `[${value.map((item) => canonical_json(item)).join(',')}]`;
	if (value && typeof value === 'object') {
		const keys = Object.keys(value as Doc)
			.filter((k) => (value as Doc)[k] !== undefined)
			.sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical_json((value as Doc)[k])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function parse_snapshot(raw: unknown): unknown {
	if (typeof raw !== 'string') return raw ?? {};
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

/** Valor estable de un campo: '' y null cuentan igual; números como texto. */
function stable_field(value: unknown): string {
	if (value === null || value === undefined) return '';
	return String(value);
}

/** SHA-256 de los campos estables + el snapshot sin volátiles. */
export function physical_device_fingerprint(doc: Doc): string {
	const fields: Doc = {};
	for (const key of STABLE_FIELDS) fields[key] = stable_field(doc[key]);
	const body = canonical_json({ fields, snapshot: stable_snapshot(parse_snapshot(doc.raw_snapshot)) });
	return createHash('sha256').update(body).digest('hex');
}

/** Hojas del snapshot estable como `raw_snapshot.ruta` → valor, para un diff legible. */
function flatten_snapshot(value: unknown, prefix: string, out: Doc) {
	if (Array.isArray(value)) {
		out[`${prefix}.length`] = value.length;
		value.forEach((item, index) => flatten_snapshot(item, `${prefix}.${index}`, out));
		return;
	}
	if (value && typeof value === 'object') {
		for (const [key, item] of Object.entries(value as Doc)) flatten_snapshot(item, `${prefix}.${key}`, out);
		return;
	}
	out[prefix] = value;
}

/**
 * Vista para el historial: sin volátiles ni huella y con el snapshot por ruta
 * («RAM: 8 GB → 16 GB», «Discos: 1 → 2») en vez de un JSON gigante.
 */
export function physical_device_history_view(doc: Doc | null): Doc | null {
	if (!doc) return doc;
	const out: Doc = { ...doc };
	for (const key of PHYSICAL_DEVICE_VOLATILE_FIELDS) delete out[key];
	delete out.hardware_fingerprint;
	delete out.raw_snapshot;
	flatten_snapshot(stable_snapshot(parse_snapshot(doc.raw_snapshot)), 'raw_snapshot', out);
	return out;
}

/** Lo que se escribe sin historial cuando el hardware no cambió. */
export function physical_device_touch(doc: Doc, fingerprint: string): Doc {
	const out: Doc = { hardware_fingerprint: fingerprint, raw_snapshot: doc.raw_snapshot ?? {} };
	for (const key of PHYSICAL_DEVICE_VOLATILE_FIELDS) out[key] = doc[key];
	return out;
}

const arr_of = (v: unknown): Doc[] =>
	Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Doc[]) : [];
const num_of = (v: unknown): number => {
	const n = typeof v === 'string' ? Number(v) : v;
	return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

/**
 * Promovidos calculados del snapshot (#335) para lista, filtros y reportes:
 * discos, capacidad total, espacio libre, VRAM, módulos de RAM y GHz.
 */
export function physical_device_promoted(raw: unknown): Doc {
	const snap = (parse_snapshot(raw) ?? {}) as Doc;
	const disks = arr_of(snap.disks ?? snap.diskLayout);
	const fs = arr_of(snap.fsSize);
	const graphics = (snap.graphics ?? {}) as Doc;
	const cpu = (snap.cpu ?? {}) as Doc;
	const out: Doc = {
		disk_count: disks.length,
		disk_total_bytes: disks.reduce((s, d) => s + num_of(d.size), 0),
		vram_total_mb: arr_of(graphics.controllers).reduce((s, c) => s + num_of(c.vram), 0),
		ram_slots_used: arr_of(snap.memLayout).filter((m) => num_of(m.size) > 0).length,
		cpu_speed_ghz: num_of(cpu.speed),
	};
	if (fs.length) out.disk_free_bytes = fs.reduce((s, f) => s + num_of(f.available), 0);
	return out;
}

/** Llaves del kárdex (#337), para el validador de plantillas. */
export const PHYSICAL_DEVICE_KARDEX_FIELDS = ['fecha', 'movimiento', 'detalle', 'usuario'] as const;

export type PhysicalDeviceKardexRow = { fecha: string; movimiento: string; detalle: string; usuario: string };

const VOLATILE_FIELD_SET = new Set<string>(PHYSICAL_DEVICE_VOLATILE_FIELDS);

/** ¿El cambio es solo ruido (último visto, memoria libre, batería…)? */
function volatile_change(path: string): boolean {
	const parts = String(path ?? '').split('.');
	if (VOLATILE_FIELD_SET.has(parts[0]!) || parts[0] === 'hardware_fingerprint') return true;
	return parts.some((part) => PHYSICAL_DEVICE_VOLATILE_KEYS.has(part.toLowerCase()));
}

function kardex_value(value: unknown): string {
	if (value === undefined || value === null || value === '') return '—';
	if (typeof value === 'boolean') return value ? 'sí' : 'no';
	if (typeof value === 'object') return Array.isArray(value) ? `${value.length} elementos` : 'datos';
	const text = String(value);
	return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

function kardex_date(value: unknown): string {
	const date = new Date(String(value ?? ''));
	if (Number.isNaN(date.getTime())) return '';
	return date.toLocaleString('es-MX', {
		timeZone: 'America/Mexico_City',
		dateStyle: 'short',
		timeStyle: 'short',
	});
}

/**
 * Historial del dispositivo → filas del kárdex, de lo más antiguo a lo más
 * reciente. Descarta entradas cuyo único cambio es volátil (historial viejo de
 * antes del #336) sin borrar nada en BD.
 */
export function physical_device_kardex(rows: Doc[]): PhysicalDeviceKardexRow[] {
	const sorted = [...rows].sort((a, b) =>
		String(a.createdAt ?? a.created_at ?? '').localeCompare(String(b.createdAt ?? b.created_at ?? '')),
	);
	const out: PhysicalDeviceKardexRow[] = [];
	for (const row of sorted) {
		const actor = (row.actor ?? {}) as Doc;
		const base = {
			fecha: kardex_date(row.createdAt ?? row.created_at),
			usuario: String(actor.name ?? actor.email ?? ''),
		};
		if (row.entryType === 'comment') {
			out.push({ ...base, movimiento: 'Comentario', detalle: kardex_value(row.commentText ?? row.actionDescription) });
			continue;
		}
		const action = String(row.actionName ?? '').toLowerCase();
		const changes = (Array.isArray(row.changes) ? row.changes : []) as Doc[];
		if (action.endsWith('creado') || String(row.operationType ?? '').toLowerCase() === 'create') {
			out.push({ ...base, movimiento: 'Alta', detalle: 'Primer reporte del equipo' });
			continue;
		}
		const real = changes.filter((change) => !volatile_change(String(change.dotPath ?? change.normalizedPath ?? '')));
		if (!real.length) continue;
		const active = real.find((change) => change.dotPath === 'is_active');
		const movimiento = active
			? active.after === false
				? 'Baja'
				: 'Reactivación'
			: real.some((change) => /^(description|name|hostname)$/.test(String(change.dotPath)))
				? 'Cambio de datos'
				: 'Cambio de hardware';
		const detalle = real
			.map((change) => {
				const label = String(change.displayLabel ?? change.dotPath ?? 'Campo').replace(/^raw_snapshot\./, '');
				return `${label}: ${kardex_value(change.before)} → ${kardex_value(change.after)}`;
			})
			.join('; ');
		out.push({ ...base, movimiento, detalle });
	}
	return out;
}

/** Valores legibles para los reportes (#337): GB y fecha local. */
export function physical_device_report_fields(doc: Doc): Doc {
	const gb = (bytes: unknown, base: number) => {
		const n = num_of(bytes);
		return n > 0 ? `${new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1 }).format(n / base ** 3)} GB` : '';
	};
	const vram = num_of(doc.vram_total_mb);
	return {
		ram_gb: gb(doc.memory_total_bytes, 1024),
		disk_total_gb: gb(doc.disk_total_bytes, 1000),
		vram_gb: vram > 0 ? `${new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1 }).format(vram / 1024)} GB` : '',
		ultima_revision: kardex_date(doc.last_seen),
	};
}
