import { describe, expect, test } from 'bun:test';
import {
	format_console_log,
	is_noisy_path,
	request_result,
	should_read_response_body,
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

describe('should_read_response_body', () => {
	test('skips PDF and other binary types so logging cannot corrupt the clone', () => {
		expect(should_read_response_body('application/pdf')).toBe(false);
		expect(should_read_response_body('application/pdf; charset=binary')).toBe(
			false,
		);
		expect(should_read_response_body('image/png')).toBe(false);
		expect(should_read_response_body('application/json')).toBe(true);
		expect(should_read_response_body('text/html; charset=utf-8')).toBe(true);
	});
});

describe('request_result', () => {
	test('adjunto sin bytes no se trata como error fatal', () => {
		expect(request_result(404, 'attachment_bytes_missing')).toBe('warning');
		expect(request_result(404, 'attachment_not_found')).toBe('warning');
		expect(request_result(404, '')).toBe('error');
	});
});
