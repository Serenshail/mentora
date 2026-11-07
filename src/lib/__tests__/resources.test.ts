import { describe, expect, it } from "vitest";
import { classifyResource, parseResourceConstraint, validateResources } from "../resources";

describe("parseResourceConstraint（用户话 → 硬约束）", () => {
  it("明确要视频+中文+大陆可达+不要文档", () => {
    const c = parseResourceConstraint("我需要 Python 学习视频，优先中文，必须能够在中国大陆正常访问，不要给我文档。");
    expect(c.resourceType).toBe("video");
    expect(c.language).toBe("zh");
    expect(c.region).toBe("mainland");
    expect(c.excluded).toContain("documentation");
  });

  it("没提约束 → any", () => {
    const c = parseResourceConstraint("帮我生成 Python 第二阶段学习计划。");
    expect(c.resourceType).toBe("any");
    expect(c.region).toBe("any");
  });
});

describe("classifyResource（URL 确定性分类）", () => {
  it("B站单集直链 = 视频 + 大陆已验证", () => {
    const r = classifyResource({ title: "x", url: "https://www.bilibili.com/video/BV1xx411c7mD" });
    expect(r.resType).toBe("video");
    expect(r.access).toBe("verified");
  });

  it("YouTube watch = 视频 + 大陆受限", () => {
    const r = classifyResource({ title: "x", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(r.resType).toBe("video");
    expect(r.access).toBe("accessible_with_conditions");
  });

  it("搜索结果页不是视频（防首页冒充）", () => {
    const r = classifyResource({ title: "x", url: "https://www.bilibili.com/search?keyword=python" });
    expect(r.resType).not.toBe("video");
  });

  it("官方文档 = 文档", () => {
    const r = classifyResource({ title: "x", url: "https://docs.python.org/3/tutorial/index.html", kind: "doc" });
    expect(r.resType).toBe("doc");
  });
});

describe("validateResources（生成后程序化校验，违规不崩溃）", () => {
  const videoOnly = parseResourceConstraint("只要视频，中文，大陆能访问，不要文档。");

  it("全文档 → 整体不 ok + 逐条违规 + 中文总结", () => {
    const report = validateResources(
      [
        { title: "Python 官方教程", url: "https://docs.python.org/3/tutorial/" },
        { title: "某博客", url: "https://blog.example.com/python" },
      ],
      videoOnly
    );
    expect(report.ok).toBe(false);
    expect(report.violations).toBe(2);
    expect(report.summary).toContain("没有找到可验证的视频");
  });

  it("混合 → 标注违规但不崩溃，视频条合规", () => {
    const report = validateResources(
      [
        { title: "B站课", url: "https://www.bilibili.com/video/BV1xx411c7mD" },
        { title: "YT课", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
        { title: "文档", url: "https://docs.python.org/3/" },
      ],
      videoOnly
    );
    expect(report.violations).toBe(2); // YT 大陆受限 + 文档违反硬约束
    expect(report.verdicts[0].violations).toHaveLength(0);
    expect(report.verdicts[1].violations.join("")).toContain("大陆访问受限");
  });

  it("B站视频满足全部约束 → ok", () => {
    const report = validateResources(
      [
        { title: "B站课", url: "https://www.bilibili.com/video/BV1xx411c7mD" },
        { title: "B站课2", url: "https://www.bilibili.com/video/BV1xx411c7mE" },
      ],
      videoOnly
    );
    expect(report.ok).toBe(true);
    expect(report.violations).toBe(0);
  });
});
