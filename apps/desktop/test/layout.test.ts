import { describe, expect, it } from "vitest";
import { moveChannel, orderBy, reorder } from "../src/lib/layout";

describe("reorder", () => {
  it("moves an item before or after another", () => {
    expect(reorder(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(reorder(["a", "b", "c"], "a", "b", "after")).toEqual(["b", "a", "c"]);
    expect(reorder(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
  });

  it("leaves the list alone for unknown items or a drop on itself", () => {
    const ids = ["a", "b"];
    expect(reorder(ids, "a", "a", "before")).toBe(ids);
    expect(reorder(ids, "x", "a", "before")).toBe(ids);
    expect(reorder(ids, "a", "x", "before")).toBe(ids);
  });
});

describe("orderBy", () => {
  const servers = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("follows the saved order and keeps new ones at the end", () => {
    expect(orderBy(servers, ["c", "a"]).map((s) => s.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("ignores ids of servers that are gone", () => {
    expect(orderBy(servers, ["gone", "d"]).map((s) => s.id)).toEqual(["d", "a", "b", "c"]);
  });
});

describe("moveChannel", () => {
  const channels = [
    { id: "t1", kind: "text", category_id: "cat", position: 0 },
    { id: "t2", kind: "text", category_id: "cat", position: 1 },
    { id: "v1", kind: "voice", category_id: "cat", position: 2 },
    { id: "v2", kind: "voice", category_id: "cat", position: 3 },
    { id: "t3", kind: "text", category_id: null, position: 0 },
  ];
  const ids = (out: { id: string }[]) => out.map((c) => c.id);

  it("reorders inside a category, among channels of the same kind", () => {
    const out = moveChannel(channels, "t2", "cat", { id: "t1", side: "before" });
    expect(out).toEqual([
      { id: "t2", category_id: "cat", position: 0 },
      { id: "t1", category_id: "cat", position: 1 },
    ]);
    expect(ids(moveChannel(channels, "v1", "cat", { id: "v2", side: "after" }))).toEqual(["v2", "v1"]);
  });

  it("moves to another category next to the channel it was dropped on", () => {
    const out = moveChannel(channels, "t3", "cat", { id: "t2", side: "before" });
    expect(out).toEqual([
      { id: "t1", category_id: "cat", position: 0 },
      { id: "t3", category_id: "cat", position: 1 },
      { id: "t2", category_id: "cat", position: 2 },
    ]);
  });

  it("goes to the end of a category without an anchor (drop on its header)", () => {
    expect(ids(moveChannel(channels, "t1", null))).toEqual(["t3", "t1"]);
    expect(moveChannel(channels, "v1", null)).toEqual([{ id: "v1", category_id: null, position: 0 }]);
  });

  it("keeps text above voice when dropped on the other kind", () => {
    expect(ids(moveChannel(channels, "t3", "cat", { id: "v2", side: "after" }))).toEqual(["t1", "t2", "t3"]);
    expect(ids(moveChannel(channels, "v2", "cat", { id: "t1", side: "before" }))).toEqual(["v2", "v1"]);
  });

  it("returns nothing for an unknown channel", () => {
    expect(moveChannel(channels, "nope", "cat")).toEqual([]);
  });
});
