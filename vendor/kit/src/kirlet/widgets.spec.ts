import { describe, expect, test } from "bun:test";
import {
  filter_widgets_for_mode,
  parse_runtime_mode,
  widget_host_id,
  widget_visible_in_mode,
} from "./widgets.js";

describe("mobile widgets", () => {
  test("host id is technicalId.widget", () => {
    expect(widget_host_id("kirlet-hr", "headcount")).toBe(
      "kirlet-hr.headcount",
    );
  });

  test("backend-only desaparece en local y queda en nube/offline", () => {
    expect(widget_visible_in_mode("backend-only", "local")).toBe(false);
    expect(widget_visible_in_mode("backend-only", "offline")).toBe(true);
    expect(widget_visible_in_mode("backend-only", "cloud")).toBe(true);
    expect(widget_visible_in_mode("embedded", "local")).toBe(true);
    expect(widget_visible_in_mode(undefined, "local")).toBe(true);
  });

  test("filter_widgets_for_mode", () => {
    const list = filter_widgets_for_mode(
      [
        { id: "a", title: "A", capability: "embedded" },
        { id: "b", title: "B", capability: "backend-only" },
      ],
      "local",
    );
    expect(list.map((w) => w.id)).toEqual(["a"]);
  });

  test("parse_runtime_mode", () => {
    expect(parse_runtime_mode("local")).toBe("local");
    expect(parse_runtime_mode("offline")).toBe("offline");
    expect(parse_runtime_mode("cloud")).toBe("cloud");
    expect(parse_runtime_mode("wifi")).toBe(null);
  });
});
