import { describe, expect, test } from 'bun:test';
import {
	handle_socket_io,
	SOCKET_IO_IDLE_TIMEOUT_SECONDS,
	SOCKET_IO_PING_MS,
} from './socket-stub.ts';

async function open_session(): Promise<string> {
	const res = handle_socket_io(
		new Request('http://imperium.test/api/socket.io/?EIO=4&transport=polling'),
	);
	expect(res).toBeInstanceOf(Response);
	const body = await (res as Response).text();
	expect(body.startsWith('0')).toBe(true);
	const open = JSON.parse(body.slice(1)) as { sid: string; pingInterval: number };
	expect(open.sid).toBeTruthy();
	expect(open.pingInterval).toBe(SOCKET_IO_PING_MS);
	return open.sid;
}

describe('socket.io stub', () => {
	test('idleTimeout outlives the long-poll ping so Bun does not hang up', () => {
		expect(SOCKET_IO_IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThan(
			SOCKET_IO_PING_MS,
		);
	});

	test('core Bun.serve wires that idleTimeout (default 10s kills polling)', async () => {
		const src = await Bun.file(new URL('../server.ts', import.meta.url)).text();
		expect(src).toContain('idleTimeout: SOCKET_IO_IDLE_TIMEOUT_SECONDS');
	});

	test('handshake returns sid', async () => {
		const sid = await open_session();
		expect(sid.length).toBeGreaterThan(8);
	});

	test('GET poll with a queued packet returns immediately', async () => {
		const sid = await open_session();
		await (
			handle_socket_io(
				new Request(
					`http://imperium.test/api/socket.io/?EIO=4&transport=polling&sid=${sid}`,
					{ method: 'POST', body: '40' },
				)
			) as Promise<Response>
		);
		const poll = handle_socket_io(
			new Request(
				`http://imperium.test/api/socket.io/?EIO=4&transport=polling&sid=${sid}`,
			),
		);
		const body = await (poll as Promise<Response> | Response).then((r) =>
			r instanceof Response ? r.text() : Promise.resolve(''),
		);
		expect(body.startsWith('40')).toBe(true);
	});

	test('client abort releases the held poll instead of writing later', async () => {
		const sid = await open_session();
		const controller = new AbortController();
		const held = handle_socket_io(
			new Request(
				`http://imperium.test/api/socket.io/?EIO=4&transport=polling&sid=${sid}`,
				{ signal: controller.signal },
			),
		);
		expect(held).toBeInstanceOf(Promise);
		controller.abort();
		const res = await (held as Promise<Response>);
		expect(res.status).toBe(499);
		expect(await res.text()).toBe('');
	});
});
