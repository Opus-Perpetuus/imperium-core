/**
 * Mitec — mismo contrato que backend/src/plugins/cobranza/cobranza-mitec.provider.ts
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const MITEC_ENDPOINT = 'https://bc.mitec.com.mx/p/gen';
const CIPHER = 'aes-128-cbc';

export type MitecCredentials = {
	key_hex: string;
	company: string;
	branch: string;
	user: string;
	password: string;
	data0: string;
};

function pick_xml(xml: string, tag: string) {
	const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
	return match ? match[1]!.trim() : '';
}

function escape_xml(value: string) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export function mitec_encrypt_xml(xml: string, key_hex: string) {
	const key = Buffer.from(key_hex, 'hex');
	const iv = randomBytes(16);
	const cipher = createCipheriv(CIPHER, key, iv);
	const encrypted = Buffer.concat([cipher.update(xml, 'utf8'), cipher.final()]);
	return Buffer.concat([iv, encrypted]).toString('base64');
}

export function mitec_decrypt_payload(encoded: string, key_hex: string) {
	const key = Buffer.from(key_hex, 'hex');
	const buf = Buffer.from(encoded, 'base64');
	const iv = buf.subarray(0, 16);
	const data = buf.subarray(16);
	const decipher = createDecipheriv(CIPHER, key, iv);
	return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function mitec_parse_callback(xml: string) {
	return {
		approved: pick_xml(xml, 'response') === 'approved',
		reference: pick_xml(xml, 'reference'),
		amount: Number(pick_xml(xml, 'amount') || 0),
		folio: pick_xml(xml, 'foliocpagos'),
	};
}

export function mitec_build_link_xml(credentials: MitecCredentials, reference: string, amount: number) {
	const inner =
		`<?xml version="1.0" encoding="UTF-8"?><P><business>` +
		`<id_company>${escape_xml(credentials.company)}</id_company>` +
		`<id_branch>${escape_xml(credentials.branch)}</id_branch>` +
		`<user>${escape_xml(credentials.user)}</user>` +
		`<pwd>${escape_xml(credentials.password)}</pwd>` +
		`</business><url>` +
		`<reference>${escape_xml(reference)}</reference>` +
		`<amount>${amount.toFixed(2)}</amount>` +
		`<moneda>MXN</moneda><canal>W</canal><version>IntegraWPP</version>` +
		`</url></P>`;
	const encrypted = mitec_encrypt_xml(inner, credentials.key_hex);
	return (
		`<?xml version="1.0" encoding="UTF-8"?><pgs>` +
		`<data0>${escape_xml(credentials.data0)}</data0>` +
		`<data>${encrypted}</data></pgs>`
	);
}

export async function mitec_create_link(
	credentials: MitecCredentials,
	reference: string,
	amount: number,
) {
	if (!credentials.key_hex) throw new Error('Mitec no está configurado (falta la llave).');
	const xml = mitec_build_link_xml(credentials, reference, amount);
	const response = await fetch(MITEC_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ xml }),
	});
	const encrypted = await response.text();
	const decrypted = mitec_decrypt_payload(encrypted, credentials.key_hex);
	if (pick_xml(decrypted, 'cd_response') !== 'success') {
		throw new Error('Mitec no generó la liga de pago.');
	}
	const url = pick_xml(decrypted, 'nb_url');
	if (!url) throw new Error('Mitec no devolvió la URL de pago.');
	return { url, raw: decrypted };
}
