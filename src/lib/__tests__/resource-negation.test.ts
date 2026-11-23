import { describe, expect, it } from "vitest";
import { parseResourceConstraint, validateResources } from "../resources";

/* 回归锁：否定词与「视频」被推荐/指代类词隔开时（「别推荐视频」「不要给我找视频」），
 * 旧实现只认「不要视频|别要视频|不想要视频」三种紧邻写法，这些说法会命中
 * wantsVideo → resourceType 被判为 "video"，与用户意图完全相反（PRD §3.1 硬约束）。 */
describe("parseResourceConstraint（否定式视频约束的间隔写法）", () => {
  const negated = [
    "别推荐视频",
    "不要推荐视频",
    "不要给我推荐视频",
    "不要给我推荐任何视频",
    "别给我找视频",
    "不想要任何视频",
    "不需要视频",
    "不想看视频",
    "我不想看到视频",
    "不要再推荐视频了",
    "别推荐视频，给我文档",
  ];

  it.each(negated)("「%s」→ 不得判成只要视频", (text) => {
    const c = parseResourceConstraint(text);
    expect(c.resourceType).not.toBe("video");
  });

  it("原有关键词仍生效（不因扩展而回退）", () => {
    for (const text of ["不要视频", "别要视频", "不想要视频"]) {
      expect(parseResourceConstraint(text).resourceType).not.toBe("video");
    }
  });

  /* 反向锁：这些句子里的「视频」是真的要视频 / 「别」不是否定词，
   * 不能被新逻辑误伤成否定。 */
  const stillWants = [
    "只要视频，中文，大陆能访问，不要文档",
    "不要文档只要视频",
    "我需要 Python 学习视频，优先中文",
    "不要钱的视频",
    "不用翻墙就能看的视频",
    "不需要注册就能看的视频",
    "特别推荐的学习视频",
    "分别推荐视频",
    "区别视频教程",
    "别的视频",
  ];

  it.each(stillWants)("「%s」→ 仍解析为要视频", (text) => {
    expect(parseResourceConstraint(text).resourceType).toBe("video");
  });

  it("noDoc 不得把已明确否定的视频翻转回 video", () => {
    // 「别推荐视频，不要文档」同时命中 noDoc，旧实现经 noDoc 再次判成 video
    const c = parseResourceConstraint("别推荐视频，不要文档");
    expect(c.resourceType).toBe("any");
  });

  it("否定约束下 validateResources 不再按视频硬约束判违规", () => {
    const c = parseResourceConstraint("别推荐视频");
    const report = validateResources(
      [{ title: "Python 官方教程", url: "https://docs.python.org/3/tutorial/" }],
      c
    );
    expect(c.resourceType).toBe("any");
    expect(report.ok).toBe(true);
  });

  it("不可信输入不得触发回溯爆炸（线性扫描）", () => {
    const evil = `不要${"推荐".repeat(2000)}`;
    const t0 = Date.now();
    parseResourceConstraint(evil);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
