import { describe, expect, test } from 'bun:test';
import {
	FCM_SERVICE_ACCOUNT_ENV,
	send_push_login_fcm,
	type PushLoginFcmMessage,
} from './push-login-fcm.ts';

const CUENTA = JSON.stringify({
	project_id: 'proyecto-prueba',
	client_email: 'fcm@prueba.invalid',
	private_key: 'llave-falsa',
});

const ENV_CON_CUENTA = { [FCM_SERVICE_ACCOUNT_ENV]: CUENTA } as NodeJS.ProcessEnv;

describe('emisor FCM del login push', () => {
	test('sin la variable de entorno no se envía', async () => {
		let called = false;
		const result = await send_push_login_fcm(
			{
				token: 'tok',
				challenge_id: 'reto-1',
				text: 'Intento de entrada desde Chrome, Guadalajara',
			},
			{
				env: {} as NodeJS.ProcessEnv,
				send: async () => {
					called = true;
				},
			},
		);
		expect(result.sent).toBe(false);
		expect(called).toBe(false);
	});

	test('un JSON inservible tampoco se envía', async () => {
		let called = false;
		const result = await send_push_login_fcm(
			{ token: 'tok', challenge_id: 'reto-1', text: 'texto' },
			{
				env: { [FCM_SERVICE_ACCOUNT_ENV]: '{no-es-json' } as NodeJS.ProcessEnv,
				send: async () => {
					called = true;
				},
			},
		);
		expect(result.sent).toBe(false);
		expect(called).toBe(false);
	});

	test('el data message lleva el id del reto y el texto, sin nonce ni número', async () => {
		const nonce = 'nonce-que-no-sale';
		const numero = '42';
		const seen: PushLoginFcmMessage[] = [];
		const input = {
			token: 'tok-1',
			challenge_id: 'reto-1',
			text: 'Intento de entrada desde Chrome, Guadalajara',
			nonce,
			number: numero,
		} as { token: string; challenge_id: string; text: string };
		const result = await send_push_login_fcm(input, {
			env: ENV_CON_CUENTA,
			send: async (message) => {
				seen.push(message);
			},
		});

		expect(result.sent).toBe(true);
		expect(seen).toHaveLength(1);
		const message = seen[0]!;
		expect(Object.keys(message).sort()).toEqual(['android', 'data', 'token']);
		expect(message).not.toHaveProperty('notification');
		expect(message.android).toEqual({ priority: 'high' });
		expect(message.data).toEqual({
			type: 'push_login',
			challenge_id: 'reto-1',
			text: 'Intento de entrada desde Chrome, Guadalajara',
		});
		const serializado = JSON.stringify(message);
		expect(serializado).not.toContain(nonce);
		expect(serializado).not.toContain(numero);
		expect(message.data).not.toHaveProperty('nonce');
		expect(message.data).not.toHaveProperty('number');
	});
});
