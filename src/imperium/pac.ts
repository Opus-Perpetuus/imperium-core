/**
 * Adaptadores PAC (mismo contrato que backend/src/components/cfdi/domain/pac).
 */

export type PacStampResult = {
	uuid: string;
	xml_timbrado: string;
	fecha_timbrado: string;
	rfc_prov_certif?: string;
	no_certificado_sat?: string;
	sello_sat?: string;
};

function env(name: string) {
	return String(process.env[name] ?? '').trim();
}

function env_prod(name: string): 'test' | 'production' {
	const raw = (env(name) || 'test').toLowerCase();
	return raw === 'production' || raw === 'prod' ? 'production' : 'test';
}

export function pac_provider() {
	return env('CFDI_PAC_PROVIDER') || 'noop';
}

function inject_tfd(
	xml: string,
	stamp: { uuid: string; fecha: string; sello_sat: string; no_cert: string; sello_cfd: string },
) {
	const tfd =
		`<tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" ` +
		`Version="1.1" UUID="${stamp.uuid}" FechaTimbrado="${stamp.fecha}" ` +
		`RfcProvCertif="MOCK010101AAA" SelloCFD="${stamp.sello_cfd}" ` +
		`NoCertificadoSAT="${stamp.no_cert}" SelloSAT="${stamp.sello_sat}"/>`;
	if (xml.includes('TimbreFiscalDigital')) return xml;
	if (xml.includes('</cfdi:Complemento>')) {
		return xml.replace('</cfdi:Complemento>', `${tfd}</cfdi:Complemento>`);
	}
	if (xml.includes('</cfdi:Comprobante>')) {
		return xml.replace(
			'</cfdi:Comprobante>',
			`<cfdi:Complemento>${tfd}</cfdi:Complemento></cfdi:Comprobante>`,
		);
	}
	return `${xml}${tfd}`;
}

async function stamp_mock(xml: string): Promise<PacStampResult> {
	const source = xml || `<?xml version="1.0"?><cfdi:Comprobante/>`;
	const uuid = crypto.randomUUID();
	const fecha = new Date().toISOString();
	const sello_sat = Buffer.from(`sat|${uuid}`).toString('base64');
	const sello_cfd = source.match(/\sSello="([^"]+)"/)?.[1] ?? Buffer.from(`cfd|${uuid}`).toString('base64');
	const no_cert = '30001000000400002495';
	return {
		uuid,
		xml_timbrado: inject_tfd(source, { uuid, fecha, sello_sat, no_cert, sello_cfd }),
		fecha_timbrado: fecha,
		rfc_prov_certif: 'MOCK010101AAA',
		no_certificado_sat: no_cert,
		sello_sat,
	};
}

async function stamp_sw(xml: string): Promise<PacStampResult> {
	const token = env('CFDI_PAC_SW_TOKEN');
	const user = env('CFDI_PAC_SW_USER');
	const password = env('CFDI_PAC_SW_PASSWORD');
	if (!token && !(user && password)) {
		throw new Error('SW sapien: configura CFDI_PAC_SW_TOKEN o CFDI_PAC_SW_USER + CFDI_PAC_SW_PASSWORD.');
	}
	if (!xml.trim()) throw new Error('SW sapien: el XML a timbrar está vacío.');
	const host = (
		env('CFDI_PAC_SW_BASE_URL') ||
		(env_prod('CFDI_PAC_SW_ENV') === 'production'
			? 'https://services.sw.com.mx'
			: 'https://services.test.sw.com.mx')
	).replace(/\/+$/, '');
	let bearer = token;
	if (!bearer) {
		const auth = await fetch(`${host}/security/authenticate`, {
			method: 'POST',
			headers: { user, password, 'Cache-Control': 'no-cache' },
		});
		const payload = (await auth.json().catch(() => ({}))) as {
			status?: string;
			data?: { token?: string } | string;
			token?: string;
			message?: string;
			messageDetail?: string;
		};
		const got =
			(typeof payload.data === 'object' && payload.data?.token) ||
			payload.token ||
			(typeof payload.data === 'string' ? payload.data : '');
		if (!auth.ok || (payload.status && payload.status !== 'success') || !got) {
			throw new Error(
				`SW sapien no pudo autenticar: ${payload.messageDetail || payload.message || `HTTP ${auth.status}`}`,
			);
		}
		bearer = got;
	}
	const form = new FormData();
	form.append('xml', new Blob([xml], { type: 'text/xml' }), 'cfdi.xml');
	const response = await fetch(`${host}/v4/cfdi33/stamp/v4`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${bearer}`, 'Cache-Control': 'no-cache' },
		body: form,
	});
	const payload = (await response.json().catch(() => ({}))) as {
		status?: string;
		message?: string;
		messageDetail?: string;
		data?: { uuid?: string; cfdi?: string; fechaTimbrado?: string; noCertificadoSAT?: string; selloSAT?: string };
	};
	if (!response.ok || payload.status !== 'success' || !payload.data?.uuid || !payload.data.cfdi) {
		throw new Error(
			`SW sapien no pudo timbrar: ${payload.messageDetail || payload.message || `HTTP ${response.status}`}`,
		);
	}
	return {
		uuid: payload.data.uuid,
		xml_timbrado: payload.data.cfdi,
		fecha_timbrado: payload.data.fechaTimbrado ?? new Date().toISOString(),
		rfc_prov_certif: 'LSO1306189R5',
		no_certificado_sat: payload.data.noCertificadoSAT,
		sello_sat: payload.data.selloSAT,
	};
}

function escape_xml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function extract_tag(xml: string, local_name: string) {
	const re = new RegExp(`<(?:[\\w-]+:)?${local_name}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${local_name}>`, 'i');
	return xml.match(re)?.[1]?.trim();
}

async function stamp_finkok(xml: string): Promise<PacStampResult> {
	const user = env('CFDI_PAC_FINKOK_USER');
	const password = env('CFDI_PAC_FINKOK_PASSWORD');
	if (!user || !password) {
		throw new Error('Finkok: configura CFDI_PAC_FINKOK_USER y CFDI_PAC_FINKOK_PASSWORD.');
	}
	if (!xml.trim()) throw new Error('Finkok: XML vacío.');
	const host = (
		env('CFDI_PAC_FINKOK_BASE_URL') ||
		(env_prod('CFDI_PAC_FINKOK_ENV') === 'production'
			? 'https://facturacion.finkok.com'
			: 'https://demo-facturacion.finkok.com')
	).replace(/\/+$/, '');
	const body =
		`<?xml version="1.0" encoding="UTF-8"?>` +
		`<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
		`xmlns:stam="http://facturacion.finkok.com/stamp">` +
		`<soapenv:Header/><soapenv:Body>` +
		`<stam:stamp>` +
		`<stam:xml><![CDATA[${xml}]]></stam:xml>` +
		`<stam:username>${escape_xml(user)}</stam:username>` +
		`<stam:password>${escape_xml(password)}</stam:password>` +
		`</stam:stamp></soapenv:Body></soapenv:Envelope>`;
	const response = await fetch(`${host}/servicios/soap/stamp`, {
		method: 'POST',
		headers: {
			'Content-Type': 'text/xml; charset=utf-8',
			SOAPAction: 'http://facturacion.finkok.com/stamp/stamp',
		},
		body,
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`Finkok stamp HTTP ${response.status}: ${text.slice(0, 240)}`);
	if (/faultstring|MensajeIncidencia|soap:Fault/i.test(text)) {
		throw new Error(
			`Finkok no pudo timbrar: ${extract_tag(text, 'faultstring') || extract_tag(text, 'MensajeIncidencia') || text.slice(0, 240)}`,
		);
	}
	const xml_timbrado = extract_tag(text, 'xml') || extract_tag(text, 'XML') || text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)?.[1];
	const uuid = extract_tag(text, 'UUID') || xml_timbrado?.match(/UUID="([^"]+)"/i)?.[1];
	if (!xml_timbrado || !uuid) {
		throw new Error(`Finkok: respuesta sin XML/UUID. Cuerpo: ${text.slice(0, 240)}`);
	}
	return {
		uuid,
		xml_timbrado: xml_timbrado
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&amp;/g, '&'),
		fecha_timbrado:
			extract_tag(text, 'FechaTimbrado') ||
			xml_timbrado.match(/FechaTimbrado="([^"]+)"/i)?.[1] ||
			new Date().toISOString(),
		rfc_prov_certif: 'SAT970701NN3',
		no_certificado_sat: extract_tag(text, 'NoCertificadoSAT') || xml_timbrado.match(/NoCertificadoSAT="([^"]+)"/i)?.[1],
		sello_sat: extract_tag(text, 'SelloSAT') || xml_timbrado.match(/SelloSAT="([^"]+)"/i)?.[1],
	};
}

async function stamp_facturama(xml: string): Promise<PacStampResult> {
	const user = env('CFDI_PAC_FACTURAMA_USER');
	const password = env('CFDI_PAC_FACTURAMA_PASSWORD');
	if (!user || !password) {
		throw new Error('Facturama: configura CFDI_PAC_FACTURAMA_USER y CFDI_PAC_FACTURAMA_PASSWORD.');
	}
	if (!xml.trim()) throw new Error('Facturama: XML vacío.');
	const host = (
		env('CFDI_PAC_FACTURAMA_BASE_URL') ||
		(env_prod('CFDI_PAC_FACTURAMA_ENV') === 'production'
			? 'https://api.facturama.mx'
			: 'https://apisandbox.facturama.mx')
	).replace(/\/+$/, '');
	const stamp_path = env('CFDI_PAC_FACTURAMA_STAMP_PATH') || '/api-lite/2/cfdis';
	const b64 = Buffer.from(xml, 'utf8').toString('base64');
	const response = await fetch(`${host}${stamp_path.startsWith('/') ? '' : '/'}${stamp_path}`, {
		method: 'POST',
		headers: {
			Authorization: `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({ Cfdi: b64, cfdi: b64, XmlBase64: b64 }),
	});
	const text = await response.text();
	let payload: Record<string, unknown> = {};
	try {
		payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
	} catch {
		throw new Error(`Facturama: respuesta no JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
	}
	if (!response.ok) {
		throw new Error(
			`Facturama no pudo timbrar: ${String(payload.Message ?? payload.message ?? text).slice(0, 300)}`,
		);
	}
	const complement = (payload.Complement as Record<string, unknown>) ?? {};
	const tax = (complement.TaxStamp as Record<string, unknown>) ?? {};
	const uuid = String(tax.Uuid ?? tax.UUID ?? payload.Uuid ?? payload.uuid ?? '');
	const id = String(payload.Id ?? payload.id ?? '');
	let xml_timbrado = String(payload.Content ?? payload.xml ?? '');
	if (xml_timbrado && !xml_timbrado.includes('<') && /^[A-Za-z0-9+/=\s]+$/.test(xml_timbrado)) {
		const decoded = Buffer.from(xml_timbrado, 'base64').toString('utf8');
		if (decoded.includes('<')) xml_timbrado = decoded;
	}
	if (!xml_timbrado) xml_timbrado = xml;
	const final_uuid = uuid || xml_timbrado.match(/UUID="([^"]+)"/i)?.[1] || id;
	if (!final_uuid) throw new Error(`Facturama: respuesta sin UUID/Id. Cuerpo: ${text.slice(0, 240)}`);
	return {
		uuid: final_uuid,
		xml_timbrado,
		fecha_timbrado: String(tax.Date ?? tax.FechaTimbrado ?? payload.Date ?? new Date().toISOString()),
		rfc_prov_certif: 'FUNK671228PH6',
		no_certificado_sat: String(tax.SatCertNumber ?? tax.NoCertificadoSAT ?? '') || undefined,
		sello_sat: String(tax.SatSeal ?? tax.SelloSAT ?? '') || undefined,
	};
}

export async function stamp_with_pac(xml: string): Promise<PacStampResult> {
	const provider = pac_provider().toLowerCase();
	if (!provider || provider === 'noop' || provider === 'none') {
		throw new Error(
			'PAC no configurado: no se puede timbrar. Configure un adaptador de PAC (set_cfdi_pac_adapter) o use solo exportación XML/JSON.',
		);
	}
	if (provider === 'mock' || provider === 'demo' || provider === 'test') {
		return stamp_mock(xml);
	}
	if (provider === 'sw_sapien' || provider === 'sw' || provider === 'smarterweb') {
		return stamp_sw(xml);
	}
	if (provider === 'finkok') return stamp_finkok(xml);
	if (provider === 'facturama') return stamp_facturama(xml);
	throw new Error(
		`CFDI_PAC_PROVIDER desconocido: "${provider}". Use noop | mock | sw_sapien | finkok | facturama.`,
	);
}
