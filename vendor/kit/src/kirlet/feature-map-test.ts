/**
 * Corridas de feature map en la app (`feature_map_test`, ver el núcleo
 * `modular/core/src/imperium/feature-map-test.ts`).
 *
 * El núcleo reenvía a la app la cabecera `x-imperium-feature-map-test` del
 * navegador; la app la guarda mientras atiende la petición y la manda en cada
 * llamada al plano de datos, para que el núcleo marque lo que se inserta.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const FEATURE_MAP_TEST_COLUMN = "feature_map_test";
export const FEATURE_MAP_TEST_HEADER = "x-imperium-feature-map-test";

const als = new AsyncLocalStorage<{ on: boolean }>();

export function feature_map_test_requested(headers: Headers | null | undefined): boolean {
  const raw = String(headers?.get(FEATURE_MAP_TEST_HEADER) ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "si" || raw === "sí" || raw === "yes";
}

export function run_with_feature_map_test<T>(on: boolean, fn: () => T): T {
  return als.run({ on }, fn);
}

export function in_feature_map_test(): boolean {
  return als.getStore()?.on === true;
}

/** Cabeceras para el plano de datos: la marca de prueba si la petición la trae. */
export function feature_map_test_headers(): Record<string, string> {
  return in_feature_map_test() ? { [FEATURE_MAP_TEST_HEADER]: "1" } : {};
}
