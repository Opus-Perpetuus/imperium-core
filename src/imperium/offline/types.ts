export type MutationStatus = "applied" | "adjusted" | "rejected" | "conflict";

export type OfflinePolicy = "si" | "provisional" | "diferido" | "no";

export type NamedMutation = {
	server_id: string;
	client_id: string;
	seq: number;
	name: string;
	version: number;
	payload: Record<string, unknown>;
};

export type MutationResult = {
	status: MutationStatus;
	reason?: string;
	row?: Record<string, unknown> | null;
	review_id?: string;
};

export type StockAlert = {
	sku: string;
	sale_id: string;
	compensated: number;
};

export type CfdiIntent = {
	id: string;
	sold_at: number;
	total: number;
};

export type ProvisionalTicket = {
	id: string;
	total: number;
	folio: string;
};

export type Authority = {
	rows: Map<string, Record<string, unknown>>;
	ledger: Map<string, MutationResult>;
	stock: Map<string, { on_hand: number; sales: string[] }>;
	alerts: StockAlert[];
	folios: Set<string>;
	cfdi: CfdiIntent[];
	reviews: { id: string; field: string; reason: string }[];
	tickets: ProvisionalTicket[];
};

export function row_key(resource: string, id: string): string {
	return `${resource}\0${id}`;
}

export function ledger_key(mutation: NamedMutation): string {
	return `${mutation.server_id}\0${mutation.client_id}\0${mutation.seq}`;
}

export function create_authority(): Authority {
	return {
		rows: new Map(),
		ledger: new Map(),
		stock: new Map(),
		alerts: [],
		folios: new Set(),
		cfdi: [],
		reviews: [],
		tickets: [],
	};
}

export function clone_authority(authority: Authority): Authority {
	return {
		rows: new Map(structuredClone([...authority.rows.entries()])),
		ledger: new Map(structuredClone([...authority.ledger.entries()])),
		stock: new Map(structuredClone([...authority.stock.entries()])),
		alerts: structuredClone(authority.alerts),
		folios: new Set(authority.folios),
		cfdi: structuredClone(authority.cfdi),
		reviews: structuredClone(authority.reviews),
		tickets: structuredClone(authority.tickets),
	};
}

export function restore_authority(target: Authority, snapshot: Authority): void {
	target.rows = snapshot.rows;
	target.ledger = snapshot.ledger;
	target.stock = snapshot.stock;
	target.alerts = snapshot.alerts;
	target.folios = snapshot.folios;
	target.cfdi = snapshot.cfdi;
	target.reviews = snapshot.reviews;
	target.tickets = snapshot.tickets;
}
