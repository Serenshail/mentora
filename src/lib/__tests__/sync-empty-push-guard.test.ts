import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ 空仓绝不自动推送云端（云端备份保护）的回归锁 ============
 * 背景：登录态下「清空全部数据」（settings resetAll）清空本机仓后，app-shell 全局挂载的
 * useAutoPush 订阅监听到 goals/books 等数组引用变化，2.5s 后调用 pushCloud()。旧实现的
 * 自动推送链路无任何空仓检查——空数组快照被服务端 /api/sync 接受成为云端 HEAD
 * （baseVersion=本机水位与云端一致不会 409），云端唯一备份被静默摧毁：本机+云端两端皆失、
 * 不可恢复。而同一张数据卡片明确写着「若刷新后本地变空，点『从云端恢复』」、
 * cloud-restore.ts 称「云端才是耐久存储」——自动推送摧毁这个兜底违背产品设计。
 *
 * 修复：闸门放在两条自动推送入口（useAutoPush 的 2.5s 防抖 timer、useFlushOnHide 的
 * pagehide flush）——正是事故路径；bootSyncForAccount / syncAfterLogin 的推送分支由
 * decideSyncAction 的「push 必须 localHas=true」前提保障（sync-decision.test.ts 已覆盖）。
 * pushOnce 本体不加闸：直接 pushCloud 的行为锁（sync-account-continuity 等）依赖
 * 空仓 mock 也能发出请求来验证账号连续性/重试语义，不属自动防抖链路。
 * 注：hasLocalData 全字段 ?? [] 读数防御（pushOnce 热路径之外多处调用方的 mock 残缺更稳）。 */

const src = readFileSync(fileURLToPath(new URL("../auth-client.ts", import.meta.url)), "utf8");

/** 抽出某个函数的函数体（花括号配平，同 sync-wiring.test.ts 的做法） */
function fnBody(marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `找不到 ${marker}`).toBeGreaterThan(-1);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`${marker} 未配平`);
}

describe("自动推送入口的空仓闸门", () => {
  it("useAutoPush 的 2.5s 防抖 timer：本机无实质数据时不发推送", () => {
    const body = fnBody("export function useAutoPush");
    const gate = body.indexOf("if (!hasLocalData()) return;");
    const push = body.indexOf("void pushCloud()");
    expect(gate).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(push);
  });

  it("useFlushOnHide 的 pagehide flush：空仓连 keepalive 也不发（无重试，推空即成 HEAD）", () => {
    const body = fnBody("export function useFlushOnHide");
    const gate = body.indexOf("if (!hasLocalData()) return;");
    const push = body.indexOf("pushCloud({ keepalive: true })");
    expect(gate).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(push);
  });

  it("两条闸门都排在 ready/dirty 闸之后（首闸语义不被削弱）", () => {
    const auto = fnBody("export function useAutoPush");
    expect(auto).toMatch(/if \(!ready\) return;/);
    const flush = fnBody("export function useFlushOnHide");
    expect(flush).toMatch(/if \(!ready \|\| !readLocalEditMarker\(\)\) return;/);
  });
});

describe("resetAll（清空本机仓）在 settings 页语义不变", () => {
  const settings = readFileSync(
    fileURLToPath(new URL("../../app/settings/page.tsx", import.meta.url)),
    "utf8"
  );

  it("清空后如实告知云端备份保留（与自动推送闸门的行为一致）", () => {
    expect(settings).toMatch(/resetAll\(\);[\s\S]{0,200}toast\.success\("已清空本机数据（云端备份未动，可随时从云端恢复）"\)/);
  });
});
