import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 多 Set-Cookie 键拼接时不得捕获出损坏的 cookie（回归锁） ============
 * 事故链（miniprogram/utils/api.js captureCookie 修复前）：
 *  `raw += Array.isArray(v) ? v.join("\n") : String(v) + "\n"` 的尾随换行只挂在
 *  String 分支上，数组分支没有分隔符。当 res.header 同时出现两个大小写不同的
 *  set-cookie 键、且第一个值是数组形式的裸 cookie（值后无 ; 属性）时，两段值
 *  直接拼在一起，/mentora_session=([^;\s]+)/ 的贪婪匹配把两段值合并捕获成
 *  一个损坏的 cookie 持久化下去（saveCookie → 后续请求鉴权失败）。
 *  已用 node 复现：{'Set-Cookie': ['mentora_session=abc123'], 'set-cookie':
 *  'mentora_session=xyz789'} → 捕获 "abc123xyz789"。
 *
 * 修复：两个分支都保证尾部分隔符 `(Array.isArray(v) ? v.join("\n") : String(v)) + "\n"`。
 * 本测试走公共路径 request()（captureCookie 未导出），断言实际持久化的 cookie 值。 */

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
    request: (opts: any) => wxRequestImpl(opts),
  };
  // config.js 是环境选择器，读 storage：wx stub 已覆盖，无需 stub config
  delete requireCjs.cache[API_PATH];
  return requireCjs(API_PATH) as {
    request: (path: string, opts?: unknown) => Promise<unknown>;
  };
}

function respondWith(header: Dict) {
  wxRequestImpl = (opts: any) => {
    opts.success({ statusCode: 200, data: {}, header });
  };
}

beforeEach(() => {
  loadApi();
});

describe("captureCookie：多 set-cookie 键（数组值）拼接的分隔符", () => {
  it("两个 set-cookie 键、首个值为数组裸 cookie：捕获第一个会话值，不把两段拼在一起", async () => {
    const api = loadApi();
    respondWith({
      "Set-Cookie": ["mentora_session=abc123"],
      "set-cookie": "mentora_session=xyz789; Path=/",
    });
    await api.request("/api/x");

    // 修复前：raw 为 "mentora_session=abc123mentora_session=xyz789; Path=/\n"，
    // 贪婪捕获 "abc123mentora_session=xyz789" 并被 saveCookie 持久化。
    const persisted = Object.values(saved).map(String);
    expect(persisted).toContain("mentora_session=abc123");
    expect(
      persisted.some((v) => v.indexOf("mentora_session=") >= 0 && v.indexOf("xyz789") >= 0),
    ).toBe(false);
  });

  it("反向顺序（首个键的值为字符串）：仍捕获正确的会话值", async () => {
    const api = loadApi();
    respondWith({
      "set-cookie": "mentora_session=first_value; Path=/",
      "Set-Cookie": ["mentora_session=second_value"],
    });
    await api.request("/api/x");

    const persisted = Object.values(saved).map(String);
    expect(persisted).toContain("mentora_session=first_value");
  });

  it("单个数组形式的 Set-Cookie（常规场景）：照常捕获（修复没有误伤）", async () => {
    const api = loadApi();
    respondWith({ "Set-Cookie": ["mentora_session=normal; Path=/; HttpOnly"] });
    await api.request("/api/x");

    expect(Object.values(saved).map(String)).toContain("mentora_session=normal");
  });

  it("空值 cookie（登出清会话）：照常清空（修复没有误伤）", async () => {
    const api = loadApi();
    // 先放一个旧值
    saved["mentora-mp-session-prod"] = "mentora_session=old";
    respondWith({ "Set-Cookie": 'mentora_session=""; Path=/' });
    await api.request("/api/x");

    const persisted = Object.values(saved).map(String);
    expect(persisted.some((v) => v.indexOf("old") >= 0)).toBe(false);
  });
});
