/**
 * PDF Direct — mismo contrato que backend/src/services/pdf-direct-print.service.ts
 */
import { createConnection } from 'node:net';
import type { ImperiumStore } from './store.ts';

const HOST_REF = 'configuration-pdf-direct-host';
const PORT_REF = 'configuration-pdf-direct-port';
const CONNECT_TIMEOUT_MS = 8000;

export type PdfDirectTarget = { host: string; port: number };

function cfg_text(value: unknown, fallback = '') {
	return String(value ?? fallback).replace(/^"+|"+$/g, '').trim() || fallback;
}

export function parse_pdf_direct_target(
	host_or_url: string,
	fallback_port = 9100,
): PdfDirectTarget {
	const raw = String(host_or_url ?? '').trim();
	if (!raw) {
		throw new Error(
			'Configura la dirección de la impresora PDF Direct en Parámetros del sistema.',
		);
	}
	let host = raw;
	let port = Number(fallback_port) || 9100;
	try {
		const with_scheme = raw.includes('://') ? raw : `tcp://${raw}`;
		const parsed = new URL(with_scheme);
		if (parsed.hostname) host = parsed.hostname;
		if (parsed.port) port = Number(parsed.port);
	} catch {
		const match = raw.match(/^\[?([^\]:/]+)\]?(?::(\d+))?$/);
		if (match?.[1]) {
			host = match[1];
			if (match[2]) port = Number(match[2]);
		}
	}
	host = host.replace(/^\[|\]$/g, '').trim();
	if (!host) throw new Error('La dirección de la impresora PDF Direct no es válida.');
	if (!Number.isFinite(port) || port < 1 || port > 65535) {
		throw new Error('El puerto de la impresora PDF Direct no es válido.');
	}
	return { host, port };
}

export async function get_pdf_direct_target(store: ImperiumStore): Promise<PdfDirectTarget> {
	const host_doc = await store.find_where('configuration', { ref: HOST_REF });
	const port_doc = await store.find_where('configuration', { ref: PORT_REF });
	const host_raw = cfg_text(host_doc?.value);
	const port_raw = Number(cfg_text(port_doc?.value, '9100'));
	return parse_pdf_direct_target(host_raw, Number.isFinite(port_raw) ? port_raw : 9100);
}

export function write_raw(target: PdfDirectTarget, data: Uint8Array): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ host: target.host, port: target.port });
		let settled = false;
		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(err);
		};
		socket.setTimeout(CONNECT_TIMEOUT_MS);
		socket.on('timeout', () =>
			fail(new Error(`Tiempo de espera agotado con ${target.host}:${target.port}.`)),
		);
		socket.on('error', (err) => fail(err));
		socket.on('connect', () => {
			socket.write(data, (err) => {
				if (err) {
					fail(err);
					return;
				}
				socket.end();
			});
		});
		socket.on('close', () => {
			if (settled) return;
			settled = true;
			resolve();
		});
	});
}

export async function send_pdf(store: ImperiumStore, data: Uint8Array) {
	if (!data?.length) throw new Error('El PDF a imprimir está vacío.');
	const target = await get_pdf_direct_target(store);
	await write_raw(target, data);
}
