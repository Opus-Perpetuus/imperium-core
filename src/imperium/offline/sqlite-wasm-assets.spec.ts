import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { SQLITE_WASM_ASSET_DIR, sqlite_wasm_init_options } from "./sqlite-wasm-open";

describe("sqlite3.wasm en el navegador", () => {
	it("lo pide a assets/sqlite/ respetando el base href", () => {
		const { locateFile } = sqlite_wasm_init_options("https://imperium-g85.tail2ca124.ts.net/internal/pos");
		expect(locateFile?.("sqlite3.wasm")).toBe("https://imperium-g85.tail2ca124.ts.net/internal/assets/sqlite/sqlite3.wasm");
		const root = sqlite_wasm_init_options("https://x.test/");
		expect(root.locateFile?.("sqlite3.wasm")).toBe("https://x.test/assets/sqlite/sqlite3.wasm");
	});

	it("en Node no cambia nada", () => {
		expect(sqlite_wasm_init_options(undefined)).toEqual({});
	});

	it("angular.json copia el wasm a la misma carpeta en todas las configuraciones", () => {
		const angular = readFileSync(new URL("../../../../../frontend/angular.json", import.meta.url), "utf8");
		const copies = angular.match(/"glob": "sqlite3\.wasm",\s*"input": "[^"]+",\s*"output": "([^"]+)"/g) ?? [];
		expect(copies.length).toBeGreaterThanOrEqual(2);
		for (const copy of copies) expect(copy).toContain(`"/${SQLITE_WASM_ASSET_DIR.replace(/\/$/, "")}"`);
	});
});
