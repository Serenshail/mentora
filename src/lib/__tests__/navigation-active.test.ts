import { describe, expect, it } from "vitest";
import { isNavigationActive } from "../navigation";

describe("navigation selection", () => {
  it.each([
    ["/", "/"], ["/life", "/life"], ["/learn", "/learn"],
    ["/learn/g1", "/learn"], ["/learn/new", "/learn"],
    ["/brain", "/brain"], ["/read/book1", "/learn"],
    ["/council", "/council"],
  ])("%s selects only %s", (pathname, selected) => {
    const active = ["/", "/life", "/learn", "/brain", "/council"].filter((href) => isNavigationActive(pathname, href));
    expect(active).toEqual([selected]);
  });
  it.each(["/lifetime", "/learning", "/reader", "/councillor"])("does not select a sibling sharing the %s prefix", (pathname) => {
    expect(["/life", "/learn", "/brain", "/council"].some((href) => isNavigationActive(pathname, href))).toBe(false);
  });
});
