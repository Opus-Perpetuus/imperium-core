/** Paquete oficial @sqlite.org, VFS opfs-sahpool. El almacén del dispositivo es este, no otro motor embebido. */
export const SQLITE_WASM_PACKAGE = "@sqlite.org/sqlite-wasm";
export const SQLITE_WASM_VFS = "opfs-sahpool";

export function wasm_sqlite_options(): { package: string; vfs: string } {
	return { package: SQLITE_WASM_PACKAGE, vfs: SQLITE_WASM_VFS };
}

export {
	browser_has_opfs,
	open_sqlite_wasm,
	sqlite_wasm_supports_opfs,
	wasm_vfs,
} from "./sqlite-wasm-open";
export type { WasmSqlite } from "./sqlite-wasm-open";
