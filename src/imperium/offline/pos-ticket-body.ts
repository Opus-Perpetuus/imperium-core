type TicketItem = {
	item_id?: { _id?: string } | string | null;
	quantity?: number;
	total?: number;
	unit_price?: number;
	price_origin?: unknown;
};

export type PosTicketSource = {
	items?: TicketItem[];
	withdrawal_signature?: string;
} & Record<string, unknown>;

export function pos_ticket_online_body(ticket: PosTicketSource): Record<string, unknown> {
	const body: Record<string, unknown> = { ...ticket };
	if (Array.isArray(ticket.items)) {
		body.items = ticket.items.map((item) => ({
			item_id: typeof item.item_id === "string" ? item.item_id : item.item_id?._id,
			quantity: item.quantity,
			total: item.total,
			unit_price: item.unit_price,
			price_origin: item.price_origin,
		}));
	}
	delete body._rev;
	delete body._attachments;
	delete body.search_field;
	return body;
}
