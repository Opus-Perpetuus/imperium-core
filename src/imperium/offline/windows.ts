export type OpenChange = {
	xid: number;
	row_id: string;
	committed: boolean;
};

/**
 * El cursor es el xmin del snapshot, no el xid más alto ya visto.
 * Una transacción que tomó el 100 puede confirmar después de la que tomó
 * el 101; avanzar hasta el 101 perdería el 100.
 */
export function create_change_log() {
	let next_xid = 1;
	const open: OpenChange[] = [];
	const committed: OpenChange[] = [];

	function snapshot_xmin(): number {
		if (open.length === 0) return next_xid;
		return Math.min(...open.map((tx) => tx.xid));
	}

	return {
		begin(row_id: string): OpenChange {
			const tx: OpenChange = { xid: next_xid, row_id, committed: false };
			next_xid += 1;
			open.push(tx);
			return tx;
		},
		commit(tx: OpenChange): void {
			const at = open.indexOf(tx);
			if (at < 0) throw new Error("La transacción no está abierta");
			open.splice(at, 1);
			tx.committed = true;
			committed.push(tx);
		},
		snapshot_xmin,
		read_since(h_prev: number): { row_ids: string[]; next_h: number } {
			const h = snapshot_xmin();
			const row_ids: string[] = [];
			const seen = new Set<string>();
			for (const tx of committed) {
				if (tx.xid < h_prev || tx.xid >= h) continue;
				if (seen.has(tx.row_id)) continue;
				seen.add(tx.row_id);
				row_ids.push(tx.row_id);
			}
			return { row_ids, next_h: h };
		},
	};
}
