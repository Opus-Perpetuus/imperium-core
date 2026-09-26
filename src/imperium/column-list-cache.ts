export class ColumnListCache {
	private readonly entries = new Map<string, { cols: string[]; at: number }>();

	constructor(
		private readonly ttl_ms: number,
		private readonly now: () => number = Date.now,
	) {}

	get(key: string): string[] | null {
		const hit = this.entries.get(key);
		if (!hit || this.now() - hit.at >= this.ttl_ms) return null;
		return hit.cols;
	}

	set(key: string, cols: string[]): void {
		this.entries.set(key, { cols, at: this.now() });
	}

	forget_schema(schema: string): void {
		for (const key of [...this.entries.keys()]) {
			if (key.startsWith(`${schema}.`)) this.entries.delete(key);
		}
	}
}
