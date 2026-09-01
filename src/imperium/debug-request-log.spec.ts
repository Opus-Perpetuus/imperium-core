import { describe, expect, test } from 'bun:test';
import {
	format_console_log,
	is_noisy_path,
} from './debug-request-log.ts';

describe('is_noisy_path', () => {
	test('skips subject log ingestion and socket.io under /api', () => {
		expect(
			is_noisy_path('/api/kirlets/svc/subject-turnos/logs'),
		).toBe(true);
		expect(
			is_noisy_path('/kirlets/svc/subject-ventas/logs'),
		).toBe(true);
		expect(is_noisy_path('/api/socket.io/?EIO=4')).toBe(true);
		expect(is_noisy_path('/socket.io/?EIO=4')).toBe(true);
		expect(is_noisy_path('/health')).toBe(true);
		expect(is_noisy_path('/api/health')).toBe(true);
	});

	test('keeps real API traffic', () => {
		expect(is_noisy_path('/api/products')).toBe(false);
		expect(is_noisy_path('/auth/menus')).toBe(false);
		expect(is_noisy_path('/subjects')).toBe(false);
	});
});

describe('format_console_log', () => {
	test('emits ANSI colors for success and error', () => {
		const ok = format_console_log('success', 'GET /products 200 3ms');
		const err = format_console_log('error', 'GET /missing 404 1ms');
		expect(ok).toContain('\x1b[');
		expect(ok).toContain('[SUCCESS]');
		expect(ok).toContain('GET /products');
		expect(err).toContain('[ERROR');
		expect(err).toContain('\x1b[0m');
	});
});
