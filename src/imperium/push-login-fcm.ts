export const FCM_SERVICE_ACCOUNT_ENV = 'IMPERIUM_FCM_SERVICE_ACCOUNT';

export type PushLoginFcmMessage = {
	token: string;
	data: {
		type: 'push_login';
		challenge_id: string;
		text: string;
	};
	android: { priority: 'high' };
};

type FcmServiceAccount = {
	project_id: string;
	client_email: string;
	private_key: string;
};

export type PushLoginFcmDeps = {
	env?: NodeJS.ProcessEnv;
	send?: (message: PushLoginFcmMessage) => Promise<unknown>;
};

function read_fcm_service_account(env: NodeJS.ProcessEnv): FcmServiceAccount | null {
	const raw = env[FCM_SERVICE_ACCOUNT_ENV]?.trim();
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<FcmServiceAccount>;
		const project_id = parsed.project_id?.trim();
		const client_email = parsed.client_email?.trim();
		const private_key = parsed.private_key?.trim();
		if (!project_id || !client_email || !private_key) return null;
		return { project_id, client_email, private_key };
	} catch {
		return null;
	}
}

function data_message(input: { token: string; challenge_id: string; text: string }): PushLoginFcmMessage {
	return {
		token: input.token,
		data: {
			type: 'push_login',
			challenge_id: input.challenge_id,
			text: input.text,
		},
		android: { priority: 'high' },
	};
}

async function send_with_firebase_admin(
	message: PushLoginFcmMessage,
	account: FcmServiceAccount,
): Promise<void> {
	const { cert, getApps, initializeApp } = await import('firebase-admin/app');
	const { getMessaging } = await import('firebase-admin/messaging');
	if (getApps().length === 0) {
		initializeApp({
			credential: cert({
				projectId: account.project_id,
				clientEmail: account.client_email,
				privateKey: account.private_key,
			}),
		});
	}
	await getMessaging().send({
		token: message.token,
		data: {
			type: message.data.type,
			challenge_id: message.data.challenge_id,
			text: message.data.text,
		},
		android: { priority: 'high' },
	});
}

export async function send_push_login_fcm(
	input: { token: string; challenge_id: string; text: string },
	deps?: PushLoginFcmDeps,
): Promise<{ sent: boolean }> {
	const account = read_fcm_service_account(deps?.env ?? process.env);
	if (!account) return { sent: false };
	const token = input.token.trim();
	const challenge_id = input.challenge_id.trim();
	const text = input.text.trim();
	if (!token || !challenge_id || !text) return { sent: false };
	const message = data_message({ token, challenge_id, text });
	if (deps?.send) {
		await deps.send(message);
		return { sent: true };
	}
	await send_with_firebase_admin(message, account);
	return { sent: true };
}
