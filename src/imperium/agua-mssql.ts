/**
 * Cliente MSSQL (SIMAPA) — mismo contrato que
 * backend/src/plugins/agua/agua-mssql.service.ts
 */
import sql from 'mssql';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export const AGUA_MSSQL_CONFIG_REFS = {
	enabled: 'configuration-agua-mssql-enabled',
	server: 'configuration-agua-mssql-server',
	port: 'configuration-agua-mssql-port',
	user: 'configuration-agua-mssql-user',
	password: 'configuration-agua-mssql-password',
	database: 'configuration-agua-mssql-database',
} as const;

export const AGUA_MSSQL_SP = {
	select_impedimento: 'USP_AGUAPOTABLE_COTROLLECTURAS_SELECT_IMPEDIMENTO',
	select_incidencia: 'USP_AGUAPOTABLE_COTROLLECTURAS_SELECT_INCIDENCIA',
	select_periodo: 'USP_AGUAPOTABLE_COTROLLECTURAS_SELECT_PERIODO',
	select_ruta_por_lecturista: 'USP_AGUAPOTABLE_COTROLLECTURAS_SELECT_RUTA_POR_LECTURISTA',
	select_tarifa_por_lecturista: 'USP_AGUAPOTABLE_COTROLLECTURAS_SELECT_TARIFA_POR_LECTURISTA',
	descarga_lectura: 'USP_AGUAPOTABLE_CONTROLLECTURAS_DESCARGA_LECTURA',
	select_contratos: 'USP_AGUAPOTABLE_CONTROLLECTURAS_SELECT_CONTRATO',
} as const;

export type AguaSyncResult = {
	catalogo: string;
	recibidos: number;
	guardados: number;
};

function cfg_text(value: unknown, fallback = '') {
	return String(value ?? fallback).replace(/^"+|"+$/g, '') || fallback;
}

function cfg_bool(value: unknown) {
	if (value === true || value === 1) return true;
	const raw = cfg_text(value, 'false').toLowerCase();
	return raw === 'true' || raw === '1';
}

async function read_config(store: ImperiumStore, ref: string) {
	return (await store.find_where('configuration', { ref }))?.value;
}

async function upsert_by(
	store: ImperiumStore,
	resource: string,
	key: string,
	id: string,
	patch: ImperiumDoc,
) {
	const existing = await store.find_where(resource, { [key]: id });
	if (existing) {
		await store.update(resource, String(existing._id), patch);
		return;
	}
	await store.insert(resource, { ...patch, [key]: id, is_active: true });
}

let cached: { key: string; pool: sql.ConnectionPool } | null = null;

export class AguaMssqlService {
	constructor(private store: ImperiumStore) {}

	async is_enabled() {
		return cfg_bool(await read_config(this.store, AGUA_MSSQL_CONFIG_REFS.enabled));
	}

	async assert_enabled() {
		if (!(await this.is_enabled())) {
			throw new Error(
				'La conexión MSSQL (SIMAPA) está deshabilitada. Actívala en Configuración para sincronizar.',
			);
		}
	}

	async build_config(): Promise<sql.config> {
		const server = cfg_text(await read_config(this.store, AGUA_MSSQL_CONFIG_REFS.server));
		const database = cfg_text(await read_config(this.store, AGUA_MSSQL_CONFIG_REFS.database));
		const user = cfg_text(await read_config(this.store, AGUA_MSSQL_CONFIG_REFS.user));
		const password = cfg_text(await read_config(this.store, AGUA_MSSQL_CONFIG_REFS.password));
		const port = Number(
			(await read_config(this.store, AGUA_MSSQL_CONFIG_REFS.port)) ?? 1433,
		);
		if (!server || !database) {
			throw new Error(
				'Configuración MSSQL incompleta: define al menos servidor y base de datos.',
			);
		}
		return {
			server,
			database,
			user,
			password,
			port: Number.isFinite(port) ? port : 1433,
			requestTimeout: 30000,
			options: { trustServerCertificate: true, encrypt: false },
			pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
		};
	}

	async get_pool(): Promise<sql.ConnectionPool> {
		await this.assert_enabled();
		const config = await this.build_config();
		const key = `${config.server}|${config.port}|${config.database}|${config.user}`;
		if (cached?.key === key && cached.pool.connected) return cached.pool;
		if (cached) {
			try {
				await cached.pool.close();
			} catch {
				/* ignore */
			}
			cached = null;
		}
		const pool = await new sql.ConnectionPool(config).connect();
		cached = { key, pool };
		return pool;
	}

	private async run_sp(
		name: string,
		params: Record<string, string | number> = {},
	): Promise<Record<string, unknown>[]> {
		const pool = await this.get_pool();
		const request = pool.request();
		for (const [key, value] of Object.entries(params)) {
			request.input(key, value);
		}
		const result = await request.execute(name);
		return (result.recordset ?? []) as Record<string, unknown>[];
	}

	async sync_impedimentos(): Promise<AguaSyncResult> {
		const rows = await this.run_sp(AGUA_MSSQL_SP.select_impedimento);
		let guardados = 0;
		for (const row of rows) {
			const id = String(row.IdImpedimento ?? '');
			if (!id) continue;
			await upsert_by(this.store, 'impedimento', 'id_impedimento', id, {
				id_impedimento: id,
				name: String(row.NombreImpedimento ?? id),
				asignar_auditoria: Boolean(row.AsignarAuditoria ?? false),
			});
			guardados += 1;
		}
		return { catalogo: 'impedimentos', recibidos: rows.length, guardados };
	}

	async sync_incidencias(): Promise<AguaSyncResult> {
		const rows = await this.run_sp(AGUA_MSSQL_SP.select_incidencia);
		let guardados = 0;
		for (const row of rows) {
			const id = String(row.IdIncidencia ?? '');
			if (!id) continue;
			await upsert_by(this.store, 'incidencia', 'id_incidencia', id, {
				id_incidencia: id,
				name: String(row.NombreIncidencia ?? id),
			});
			guardados += 1;
		}
		return { catalogo: 'incidencias', recibidos: rows.length, guardados };
	}

	async sync_periodos(): Promise<AguaSyncResult> {
		const rows = await this.run_sp(AGUA_MSSQL_SP.select_periodo);
		let guardados = 0;
		for (const row of rows) {
			const id = String(row.IdPeriodo ?? '');
			if (!id) continue;
			await upsert_by(this.store, 'periodo', 'id_periodo', id, {
				id_periodo: id,
				name: String(row.NombrePeriodo ?? id),
				meses_por_periodo: Number(row.MesesPorPeriodo ?? 2),
			});
			guardados += 1;
		}
		return { catalogo: 'periodos', recibidos: rows.length, guardados };
	}

	async sync_rutas(id_lecturista: string): Promise<AguaSyncResult> {
		const rows = await this.run_sp(AGUA_MSSQL_SP.select_ruta_por_lecturista, {
			IdLecturista: id_lecturista,
		});
		let guardados = 0;
		for (const row of rows) {
			const id = String(row.IdRuta ?? '');
			if (!id) continue;
			await upsert_by(this.store, 'ruta', 'id_ruta', id, {
				id_ruta: id,
				name: String(row.NombreRuta ?? id),
				vigencia: Number(row.VigenciaRuta ?? 0) || undefined,
				periodo: Number(row.PeriodoRuta ?? 0) || undefined,
			});
			guardados += 1;
		}
		return { catalogo: 'rutas', recibidos: rows.length, guardados };
	}

	async sync_tarifas(id_lecturista: string): Promise<AguaSyncResult> {
		const rows = await this.run_sp(AGUA_MSSQL_SP.select_tarifa_por_lecturista, {
			IdLecturista: id_lecturista,
		});
		let guardados = 0;
		for (const row of rows) {
			const id = String(row.IdTarifa ?? '');
			if (!id) continue;
			await upsert_by(this.store, 'tarifa', 'id_tarifa', id, {
				id_tarifa: id,
				name: `Tarifa ${id}`,
				vigencia: Number(row.Vigencia ?? 0),
				consumo_minimo: Number(row.ConsumoMinimo ?? 0),
				consumo_maximo: Number(row.ConsmuoMaximo ?? row.ConsumoMaximo ?? 0),
				cuota_minima: Number(row.CuotaMinima ?? 0),
				costo_mt3_excedente: Number(row.CostoMt3Excedente ?? 0),
			});
			guardados += 1;
		}
		return { catalogo: 'tarifas', recibidos: rows.length, guardados };
	}

	async sync_contratos(
		id_ruta?: string,
	): Promise<AguaSyncResult & { stub: true; message: string }> {
		const where: Record<string, unknown> = {};
		if (id_ruta) where.id_ruta = id_ruta;
		const total = await this.store.count('contrato', {
			where: Object.keys(where).length ? where : undefined,
		});
		const enabled = await this.is_enabled();
		return {
			catalogo: 'contratos',
			recibidos: total,
			guardados: total,
			stub: true,
			message: enabled
				? 'MSSQL no expone SP de contratos documentado; se reutilizan contratos Mongo por IdRuta.'
				: 'MSSQL deshabilitado; pull local de contratos por IdRuta.',
		};
	}

	async push_lectura(lectura: ImperiumDoc): Promise<boolean> {
		const pool = await this.get_pool();
		const request = pool.request();
		request.input('Contrato', String(lectura.contrato ?? ''));
		request.input('Vigencia', Number(lectura.vigencia ?? 0));
		request.input('Periodo', Number(lectura.periodo ?? 0));
		request.input('LecturaActual', Number(lectura.lectura_actual ?? 0));
		request.input('ConsumoMts3', Number(lectura.consumo_mts3 ?? 0));
		request.input('Mts3Cobrados', Number(lectura.mts3_cobrados ?? 0));
		request.input('IdTarifa', String(lectura.id_tarifa ?? ''));
		request.input('IdImpedimento', String(lectura.id_impedimento ?? ''));
		request.input('IdIncidencia', String(lectura.id_incidencia ?? ''));
		request.input('IdLecturista', String(lectura.id_lecturista ?? ''));
		request.input('IdRuta', String(lectura.id_ruta ?? ''));
		request.input('Importe', Number(lectura.importe ?? 0));
		request.input('Observaciones', String(lectura.observaciones ?? ''));
		await request.execute(AGUA_MSSQL_SP.descarga_lectura);
		return true;
	}
}
