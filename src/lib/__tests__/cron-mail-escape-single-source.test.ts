import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { escapeHtml } from "../server/mail-html";

/* 回归锁（2026-11 复核）：提醒邮件（cron/tick）与周报邮件（cron/weekly-digest）共用的
 * HTML 转义函数此前各有逐字相同的本地实现（tick 注释自己承认「与 weekly-digest:184 的
 * escapeHtml 同款」）——admin/overview 点名的反模式（「收口到单一实现，此前本文件复制过
 * 一份——漂移即事故隐患」）：两份拷贝一旦只有一份修了转义缺口，同一条用户输入在两条
 * cron 链路上获得不同等级的注入防护。
 * 修复：实现收口到 lib/server/mail-html.ts，两个路由 import 同一来源。
 * 行为锁（cron-tick-email-escape.test.ts）继续覆盖 tick 链路；这里锁「单一来源」本身。 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("邮件 HTML 转义收口单一实现", () => {
  it("cron/tick 不再有本地 escapeHtml，改从 lib/server/mail-html 导入", () => {
    const src = read("../../app/api/cron/tick/route.ts");
    expect(src).toMatch(/import \{ escapeHtml \} from "@\/lib\/server\/mail-html"/);
    expect(src).not.toMatch(/function escapeHtml/);
  });

  it("cron/weekly-digest 不再有本地 escapeHtml，改从 lib/server/mail-html 导入", () => {
    const src = read("../../app/api/cron/weekly-digest/route.ts");
    expect(src).toMatch(/import \{ escapeHtml \} from "@\/lib\/server\/mail-html"/);
    expect(src).not.toMatch(/function escapeHtml/);
  });

  it("共享实现转义 & < > \"（与两份旧实现逐字同序，& 必须最先防二次转义）", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe(`&lt;a href=&quot;x&quot;&gt;&amp;'`);
    expect(escapeHtml(`<b>`)).toBe("&lt;b&gt;");
    expect(escapeHtml(`a&b`)).toBe("a&amp;b");
    expect(escapeHtml(`"`)).toBe("&quot;");
    expect(escapeHtml("文本")).toBe("文本");
  });
});
