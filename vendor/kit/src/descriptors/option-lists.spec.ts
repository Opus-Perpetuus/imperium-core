import { describe, expect, test } from "bun:test";
import {
  GENERAL_OPTION_LIST_SEED_PATH,
  OPTION_SEED_ACTION,
  STATUS_OPTION_SEED_PATH,
  general_option_list_options_source,
} from "./option-lists.js";

describe("general option list optionsSource", () => {
  test("el campo enlaza la lista del núcleo con as=options", () => {
    expect(general_option_list_options_source("PosTickets", "metodo_pago")).toBe(
      "api://general-option-list-control/options?model_id=PosTickets&list_key=metodo_pago&as=options",
    );
  });

  test("la reparación es seed_defaults en estatus y en listas generales", () => {
    expect(OPTION_SEED_ACTION).toBe("seed_defaults");
    expect(STATUS_OPTION_SEED_PATH).toBe("/api/status-option-control/seed-defaults");
    expect(GENERAL_OPTION_LIST_SEED_PATH).toBe(
      "/api/general-option-list-control/seed-defaults",
    );
  });
});
