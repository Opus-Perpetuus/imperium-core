import { describe, expect, test } from "bun:test";
import {
  PUBLIC_LANDING_ENABLED_DEFAULT,
  PUBLIC_LANDING_ENABLED_REF,
  PUBLIC_LANDING_ENABLED_TYPE,
  is_public_landing_enabled,
  public_landing_configuration_seed,
} from "./public-landing-flag.js";

describe("is_public_landing_enabled", () => {
  test("verdadero y falso booleanos", () => {
    expect(is_public_landing_enabled(true)).toBe(true);
    expect(is_public_landing_enabled(false)).toBe(false);
  });

  test("ausente o ilegible conserva el default (landing oculta)", () => {
    expect(is_public_landing_enabled(undefined)).toBe(
      PUBLIC_LANDING_ENABLED_DEFAULT,
    );
    expect(is_public_landing_enabled(null)).toBe(PUBLIC_LANDING_ENABLED_DEFAULT);
    expect(is_public_landing_enabled("")).toBe(PUBLIC_LANDING_ENABLED_DEFAULT);
    expect(PUBLIC_LANDING_ENABLED_DEFAULT).toBe(false);
  });

  test("cadenas SI/NO y JSON de booleanos", () => {
    expect(is_public_landing_enabled("false")).toBe(false);
    expect(is_public_landing_enabled("true")).toBe(true);
    expect(is_public_landing_enabled("NO")).toBe(false);
    expect(is_public_landing_enabled("SI")).toBe(true);
  });
});

describe("public_landing_configuration_seed", () => {
  test("semilla switch con valor booleano verdadero/falso", () => {
    const seed = public_landing_configuration_seed();
    expect(seed._ref).toBe(PUBLIC_LANDING_ENABLED_REF);
    expect(seed.type).toBe(PUBLIC_LANDING_ENABLED_TYPE);
    expect(seed.type).toBe("switch");
    expect(seed.value).toBe(false);
    expect(typeof seed.value).toBe("boolean");
    expect(seed.is_system).toBe(true);
  });
});
