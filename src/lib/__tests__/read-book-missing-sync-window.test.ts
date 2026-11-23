import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ /read/[id] 直达链接在云端快照未拉回时的三态回归锁 ============
 * 背景：useHydrated 在 /api/auth/me 探测结束（checking=false）即放行，而 bootSync 是
 * 探测后异步发起的云端拉取（runAuthProbe → void bootSync()）。新设备/新浏览器登录后经
 * 书签或历史直达 /read/[id] 时，本地仓还没有这本书——旧实现立即渲染「书不存在。返回书架」
 * 终态错误；几秒后快照落地组件自愈，但用户在这个窗口看到的是误导性提示、可能点「返回书架」
 * 离开。bootSync 拉取失败时页面也没有任何同步失败/重试提示。
 * 修复：已登录且首轮同步未落定时呈现「同步中」；同步失败（syncStatus=error）时给出
 * retryCloudSync 重试入口；未登录（本地仓即真相）保持原错误态。 */

const PAGE = readFileSync(join(process.cwd(), "src/app/read/[id]/page.tsx"), "utf8");

describe("书不存在 ≠ 云端还没拉回来", () => {
  it("已登录时先等 bootSync（幂等去重），未登录直接判不存在", () => {
    const effect = PAGE.slice(PAGE.indexOf("const [cloudSyncing"), PAGE.indexOf("const [assessBusy]"));
    expect(effect).toMatch(/if \(!hydrated \|\| book\) return;/);
    expect(effect).toMatch(/bootSync\(\)/);
    expect(effect).toMatch(/if \(!useAuthStore\.getState\(\)\.user\) return;/);
  });

  it("!book 分支：同步中骨架（不放「返回书架」终态）", () => {
    const missing = PAGE.slice(PAGE.indexOf("if (!book) {"), PAGE.indexOf("const readStatus"));
    expect(missing).toMatch(/if \(cloudSyncing\) \{/);
    expect(missing).toMatch(/正在从云端同步这本书…/);
  });

  it("同步失败（error）时在错误态里提供重试入口", () => {
    const missing = PAGE.slice(PAGE.indexOf("if (!book) {"), PAGE.indexOf("const readStatus"));
    expect(missing).toMatch(/syncStatus === "error"/);
    expect(missing).toMatch(/void retryCloudSync\(\)/);
  });

  it("useSyncStatus / retryCloudSync 从 auth-client 导入", () => {
    expect(PAGE).toMatch(/import \{ useSyncStatus, retryCloudSync \} from "@\/lib\/auth-client"/);
  });
});
