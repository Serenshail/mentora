import { describe, expect, it } from "vitest";
import { isDue, localNow, sanitizeMemoryInput, sanitizeReminderInput } from "../server/personal";

/* personal.ts 顶部 import "server-only" —— 与其他服务端模块测试同法豁免 */
vi.mock("server-only", () => ({}));
import { vi } from "vitest";

describe("localNow（用户时区的日期/时间/星期）", () => {
  it("按 Asia/Shanghai 解析 UTC 时刻", () => {
    const at = new Date("2026-11-05T00:30:00Z"); // 北京 08:30
    const n = localNow("Asia/Shanghai", at);
    expect(n.date).toBe("2026-11-05");
    expect(n.hhmm).toBe("08:30");
    expect(n.weekday).toBe(4); // 2026-11-05 是周四
  });

  it("非法时区回退上海，不抛异常", () => {
    const n = localNow("Not/AZone", new Date("2026-11-05T00:30:00Z"));
    expect(n.date).toBe("2026-11-05");
  });
});

describe("isDue（定时提醒到期判定）", () => {
  const base = {
    id: "rem_1", title: "复习", prompt: "去复习", time: "08:00", days: [] as number[],
    timezone: "Asia/Shanghai", enabled: true, createdAt: "2026-11-01T00:00:00Z",
  };

  it("到点且当天未发 → due", () => {
    const r = isDue(base, new Date("2026-11-05T00:05:00Z")); // 北京 08:05
    expect(r.due).toBe(true);
    expect(r.key).toBe("2026-11-05 08:00");
  });

  it("未到点 → 不 due", () => {
    expect(isDue(base, new Date("2026-11-04T23:00:00Z")).due).toBe(false); // 北京 07:00
  });

  it("当天已发（lastRunKey 命中）→ 不重复发（幂等）", () => {
    expect(isDue({ ...base, lastRunKey: "2026-11-05 08:00" }, new Date("2026-11-05T02:00:00Z")).due).toBe(false);
  });

  it("停用 → 不 due", () => {
    expect(isDue({ ...base, enabled: false }, new Date("2026-11-05T02:00:00Z")).due).toBe(false);
  });

  it("限定星期：非当天不 due（周四 vs 只周一）", () => {
    expect(isDue({ ...base, days: [1] }, new Date("2026-11-05T02:00:00Z")).due).toBe(false);
    expect(isDue({ ...base, days: [4] }, new Date("2026-11-05T02:00:00Z")).due).toBe(true);
  });

  it("跨天错过不追发（昨天的时刻今天不算到期）", () => {
    const r = isDue({ ...base, time: "23:59", lastRunKey: "2026-11-04 23:59" }, new Date("2026-11-05T00:05:00Z"));
    // 今天 08:05 未到 23:59 → 不 due；昨天那条已发过，不补
    expect(r.due).toBe(false);
    expect(r.key).toBe("2026-11-05 23:59");
  });
});

describe("输入校验", () => {
  it("记忆：过短拒绝、标签最多 5 个", () => {
    expect("error" in sanitizeMemoryInput({ text: "hi" })).toBe(true);
    const ok = sanitizeMemoryInput({ text: "我习惯用 Python 写脚本", tags: ["a", "b", "c", "d", "e", "f", "g"] });
    if ("error" in ok) throw new Error("should be valid");
    expect(ok.tags).toHaveLength(5);
  });

  it("提醒：时间格式与星期过滤", () => {
    expect("error" in sanitizeReminderInput({ title: "复习", time: "8:00" })).toBe(true);
    expect("error" in sanitizeReminderInput({ title: "复习", time: "25:00" })).toBe(true);
    const ok = sanitizeReminderInput({ title: "复习", time: "08:00", days: [8, -1, 1, 1, 3] });
    if ("error" in ok) throw new Error("should be valid");
    expect(ok.days).toEqual([1, 3]);
    expect(ok.timezone).toBe("Asia/Shanghai");
  });
});
