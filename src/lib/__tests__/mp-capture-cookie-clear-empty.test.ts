import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ captureCookie：服务端裸空值清 cookie 响应必须真的清掉本机备份 ============
 * 事故链（miniprogram/utils/api.js captureCookie 修复前）：服务端
 * clearSessionCookie（src/lib/server/auth.ts jar.set(COOKIE, "", { maxAge: 0 })）
 * 线上格式是 `mentora_session=; Path=/; Max-Age=0`（值后无引号、无内容）。
 * 捕获正则 /mentora_session=([^;\s]+)/ 要求等号后至少 1 个非分隔字符，对这一
 * 格式返回 null——`if (m[1] === "")` 的清空分支永远走不到，本机 wx storage 的
 * cookie 备份不随服务端清除指令清掉（只有带引号的 mentora_session="" 命中）。
 * logout() 自己先 saveCookie("") 掩盖了这条路径，但任何其它返回清 cookie 的
 * 接口（如账号删除）都会留下失效备份。
 * 修复：量词 + → *，允许空值；清空分支从死代码变成可达。
 * 本测试走公共路径 request()（captureCookie 未导出），断言实际持久化结果。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;

const API_PATH = join(ROOT, "miniprogram/utils/api.js");

let saved: Dict;
let wxRequestImpl: (opts: any) => void;

function loadApi() {
  const g = globalThis as unknown as Record<string, unknown>;
  saved = {};
  g.wx = {
    getStorageSync: (k: string) => saved[k],
    setStorageSync: (k: string, v: unknown) => {
      saved[k] = v;
    },
    removeStorageSync: (k: string) => {
      delete saved[k];
    },
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    request: (opts: any) => wxRequestImpl(opts),
  };
  delete requireCjs.cache[API_PATH];
  return requireCjs(API_PATH) as { request: (p: string, o?: unknown) => Promise<unknown> };
}

function respondWith(header: Dict) {
  wxRequestImpl = (opts: any) => {
    opts.success({ statusCode: 200, data: {}, header });
  };
}

beforeEach(() => {
  loadApi();
});

describe("captureCookie 裸空值清 cookie", () => {
  it("服务端裸空值（mentora_session=; Max-Age=0）：本机备份被清掉", async () => {
    const api = loadApi();
    saved["mentora-mp-session-prod"] = "mentora_session=stale-value; Path=/";
    respondWith({ "Set-Cookie": "mentora_session=; Path=/; Max-Age=0" });
    await api.request("/api/x");

    const persisted = Object.values(saved).map(String);
    expect(persisted.some((v) => v.indexOf("stale-value") >= 0)).toBe(false);
    expect(
      persisted.some((v) => v.indexOf("mentora_session=") >= 0),
    ).toBe(false);
  });

  it("带引号空值（mentora_session=\"\"）：照常清空（修复不误伤）", async () => {
    const api = loadApi();
    saved["mentora-mp-session-prod"] = "mentora_session=old";
    respondWith({ "Set-Cookie": 'mentora_session=""; Path=/' });
    await api.request("/api/x");
    expect(Object.values(saved).map(String).some((v) => v.indexOf("old") >= 0)).toBe(false);
  });

  it("正常下发会话值：照常捕获（修复不误伤）", async () => {
    const api = loadApi();
    respondWith({ "Set-Cookie": "mentora_session=fresh123; Path=/; HttpOnly" });
    await api.request("/api/x");
    expect(Object.values(saved).map(String)).toContain("mentora_session=fresh123");
  });
});
