import { describe, expect, it } from "vitest";
import { rankResources, KIND_LABEL } from "../utils";
import type { Resource } from "../types";

describe("rankResources（新近+实用优先、经典降权）", () => {
  const rs: Resource[] = [
    { title: "经典旧书", why: "", kind: "classic", year: 1990, evergreen: true },
    { title: "新官方文档", why: "", kind: "doc", year: 2025 },
    { title: "旧教程", why: "", kind: "tutorial", year: 2016 },
  ];
  it("官方/新资料排前,经典沉底", () => {
    const out = rankResources(rs);
    expect(out[0].title).toBe("新官方文档");
    expect(out[out.length - 1].title).toBe("经典旧书");
  });
  it("evergreen 一律最后", () => {
    const out = rankResources([rs[0], { title: "新视频课", why: "", kind: "course", year: 2024 }]);
    expect(out[out.length - 1].evergreen).toBe(true);
  });
  it("KIND_LABEL 覆盖主要类型", () => {
    expect(KIND_LABEL.doc).toBeTruthy();
    expect(KIND_LABEL.repo).toBeTruthy();
  });
});
