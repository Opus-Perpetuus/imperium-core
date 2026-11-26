import { describe, expect, test } from 'bun:test';
import { diff_docs } from './history.ts';
import {
	canonical_json,
	physical_device_fingerprint,
	physical_device_history_view,
	physical_device_promoted,
	physical_device_touch,
	stable_snapshot,
} from './physical-device-report.ts';

const base = () => ({
	name: 'PC-CAJA-1',
	install_uuid: 'u-1',
	hostname: 'PC-CAJA-1',
	model: 'OptiPlex',
	cpu_cores: 8,
	memory_total_bytes: 8 * 1024 ** 3,
	primary_mac: 'aa:bb',
	primary_ip4: '10.0.0.5',
	last_seen: '2026-11-24T07:00:00.000Z',
	last_user_name: 'Ana',
	raw_snapshot: {
		memory: { total: 8 * 1024 ** 3, free: 100, used: 200, available: 300 },
		battery: { percent: 80, isCharging: true },
		diskLayout: [{ name: 'SSD', size: 512 }],
		fsSize: [{ fs: '/dev/sda1', size: 500, used: 100, available: 400, use: 20 }],
		networkInterfaces: [{ iface: 'eth0', mac: 'aa:bb', ip4: '10.0.0.5', speed: 1000 }],
	},
});

describe('reporte de dispositivos sin historial vacío (#336)', () => {
	test('mismo equipo con memoria libre, batería, IP, usuario y fecha distintos → misma huella', () => {
		const a = base();
		const b = base();
		b.raw_snapshot.memory.free = 999;
		b.raw_snapshot.battery.percent = 12;
		b.raw_snapshot.fsSize[0].used = 300;
		b.raw_snapshot.networkInterfaces[0].ip4 = '10.0.0.9';
		b.primary_ip4 = '10.0.0.9';
		b.last_seen = '2026-11-24T08:00:00.000Z';
		b.last_user_name = 'Beto';
		expect(physical_device_fingerprint(b)).toBe(physical_device_fingerprint(a));
	});

	test('el orden de llaves y el snapshot guardado como texto no cambian la huella', () => {
		const a = base();
		const b = { ...base(), raw_snapshot: JSON.stringify({ ...base().raw_snapshot }) } as Record<string, unknown>;
		expect(physical_device_fingerprint(b)).toBe(physical_device_fingerprint(a));
		expect(canonical_json({ b: 1, a: 2 })).toBe(canonical_json({ a: 2, b: 1 }));
	});

	test('RAM 8→16 GB o un disco más → huella distinta', () => {
		const a = base();
		const ram = base();
		ram.memory_total_bytes = 16 * 1024 ** 3;
		ram.raw_snapshot.memory.total = 16 * 1024 ** 3;
		const disk = base();
		disk.raw_snapshot.diskLayout.push({ name: 'HDD', size: 1000 });
		expect(physical_device_fingerprint(ram)).not.toBe(physical_device_fingerprint(a));
		expect(physical_device_fingerprint(disk)).not.toBe(physical_device_fingerprint(a));
	});

	test('el diff del historial solo trae el cambio real, por ruta y sin volátiles', () => {
		const a = base();
		const b = base();
		b.raw_snapshot.diskLayout.push({ name: 'HDD', size: 1000 });
		b.raw_snapshot.memory.free = 1;
		b.last_seen = '2026-11-24T09:00:00.000Z';
		const changes = diff_docs(physical_device_history_view(a), physical_device_history_view(b));
		const paths = changes.map((c) => c.dotPath).sort();
		expect(paths).toEqual([
			'raw_snapshot.diskLayout.1.name',
			'raw_snapshot.diskLayout.1.size',
			'raw_snapshot.diskLayout.length',
		]);
		const quiet = diff_docs(physical_device_history_view(base()), physical_device_history_view({ ...base(), last_seen: 'x' }));
		expect(quiet).toEqual([]);
	});

	test('el toque sin historial solo lleva volátiles, snapshot y huella', () => {
		const touch = physical_device_touch(base(), 'h');
		expect(Object.keys(touch).sort()).toEqual(
			['disk_free_bytes', 'hardware_fingerprint', 'last_seen', 'last_user_id', 'last_user_name', 'primary_ip4', 'raw_snapshot'].sort(),
		);
		expect(stable_snapshot({ battery: { percent: 1 }, cpu: { cores: 4 } })).toEqual({ cpu: { cores: 4 } });
	});
});

describe('promovidos del snapshot (#335)', () => {
	test('discos, capacidad, VRAM, módulos de RAM, GHz y libre', () => {
		const p = physical_device_promoted({
			disks: [{ size: 512e9 }, { size: 1e12 }],
			fsSize: [{ available: 300e9 }, { available: 900e9 }],
			graphics: { controllers: [{ vram: 4096 }] },
			memLayout: [{ size: 4 }, { size: 4 }, { size: 0 }],
			cpu: { speed: 3.1 },
		});
		expect(p).toEqual({
			disk_count: 2,
			disk_total_bytes: 1.512e12,
			vram_total_mb: 4096,
			ram_slots_used: 2,
			cpu_speed_ghz: 3.1,
			disk_free_bytes: 1.2e12,
		});
		expect(physical_device_promoted(null).disk_count).toBe(0);
	});
});

describe('reportes de dispositivos (#337)', () => {
	test('kárdex: antiguo → reciente, sin revisiones vacías, con alta, cambio y baja', async () => {
		const { physical_device_kardex } = await import('./physical-device-report.ts');
		const rows = physical_device_kardex([
			{ createdAt: '2026-11-03T10:00:00Z', actionName: 'Dispositivo actualizado', actor: { name: 'Ana' }, changes: [{ dotPath: 'is_active', displayLabel: 'activo', before: true, after: false }] },
			{ createdAt: '2026-11-01T10:00:00Z', actionName: 'Dispositivo creado', actor: { name: 'Ana' }, changes: [] },
			{ createdAt: '2026-11-02T09:00:00Z', actionName: 'Dispositivo actualizado', changes: [{ dotPath: 'last_seen', before: 'a', after: 'b' }, { dotPath: 'raw_snapshot.memory.free', before: 1, after: 2 }] },
			{ createdAt: '2026-11-02T10:00:00Z', actionName: 'Dispositivo actualizado', actor: { name: 'Beto' }, changes: [{ dotPath: 'memory_total_bytes', displayLabel: 'RAM', before: 8, after: 16 }] },
		]);
		expect(rows.map((r) => r.movimiento)).toEqual(['Alta', 'Cambio de hardware', 'Baja']);
		expect(rows[1]).toMatchObject({ detalle: 'RAM: 8 → 16', usuario: 'Beto' });
	});


	test('las plantillas oficiales se pueden guardar aunque no haya filas (disk_count es virtual, #337)', async () => {
		const { assert_report_template_write } = await import('./reports-flow.ts');
		const { default: seeds } = await import('./physical-device-report-seeds.json');
		const cols = [
			'name', 'description', 'is_active', 'serial', 'manufacturer', 'model',
			'os_distro', 'os_release', 'cpu_brand', 'gpu_primary', 'device_kind',
			'last_user_name', 'memory_total_bytes',
		].map((name) => ({ name, pg: 'text' }));
		const locs = new Map([['physical-device', { columns: cols }]]);
		const store = {
			locs,
			has: (resource: string) => locs.has(resource),
			loc: (resource: string) => locs.get(resource)!,
			field_refs: () => ({}),
			resource_for_model: () => null,
			async find_many() {
				return { rows: [], total: 0 };
			},
		};
		for (const { doc } of seeds as Array<{ doc: { html_content: string } }>) {
			await assert_report_template_write(store as never, {
				related_model: 'physical-device',
				html_content: doc.html_content,
			});
		}
	});

	test('las plantillas sembradas pintan inventario y kárdex', async () => {
		const { interpolate_report_list, interpolate_report_template } = await import('./reports-flow.ts');
		const { default: seeds } = await import('./physical-device-report-seeds.json');
		const { physical_device_report_fields } = await import('./physical-device-report.ts');
		const doc = { _id: 'd1', name: 'PC-1', memory_total_bytes: 8 * 1024 ** 3, disk_count: 2, disk_total_bytes: 1.5e12, vram_total_mb: 4096 };
		const full = { ...doc, ...physical_device_report_fields(doc), kardex: [{ fecha: '01/11/26', movimiento: 'Alta', detalle: 'Primer reporte', usuario: 'Ana' }] };
		const inv = await interpolate_report_list(seeds[0]!.doc.html_content, [full, { ...full, name: 'PC-2' }], 'Ana', new Date(), {});
		expect(inv).toContain('PC-2');
		expect(inv).toContain('8 GB');
		expect(inv).toContain('Total de dispositivos: 2');
		const kar = await interpolate_report_template(seeds[1]!.doc.html_content, full, 'Ana', new Date(), {});
		expect(kar).toContain('Primer reporte');
		expect(kar).toContain('4 GB');
	});
});
