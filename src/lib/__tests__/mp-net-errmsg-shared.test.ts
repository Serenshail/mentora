import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 网络层错误文案映射收口到 api.netErrMsg（回归锁） ============
 * 事故链：api.js 与 chat.js 各写一份 errMsg→中文映射，已经漂移——"domain list"
 * 分支只有 JSON 通道有：同一类域名不可达错误，登录/注册（JSON 通道）显示
 * 「当前网络无法访问服务」而聊天流式通道显示「网络请求失败」。下次微信新增
 * errMsg 形态只改一处就会复现「登录页修了、聊天页漏了」的事故模式。
 * 修复：唯一映射收口在 api.netErrMsg；abort 文案两通道语义不同（JSON 通道
 * 「请求已取消」/ 流式通道「生成已停止」），以参数传入。
 * 本锁钉住：两条通道的 fail 路径文案一致（abort 参数差异除外）、域名词缺失
 * 分支在两条通道都在。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();
const API_PATH = join(ROOT, "miniprogram/utils/api.js");
const CHAT_PATH = join(ROOT, "miniprogram/utils/chat.js");

type Dict = Record<string, unknown>;

function installWx(requestImpl: (opts: any) => void) {
  const g = globalThis as unknown as Record<string, unknown>;
  g.wx = {
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    request: requestImpl,
  };
}

function loadModules() {
  for (const p of [API_PATH, CHAT_PATH]) delete requireCjs.cache[p];
  const api = requireCjs(API_PATH) as Dict & {
    request: (p: string, o?: unknown) => Promise<unknown>;
    netErrMsg: (err: unknown, abortCopy?: string) => string;
  };
  const chat = requireCjs(CHAT_PATH) as Dict & { streamChat: (o: any) => Promise<string> };
  return { api, chat };
}

function requestFailsWith(errMsg: string): Promise<unknown> {
  installWx((opts: any) => {
    setTimeout(() => opts.fail({ errMsg }), 0);
  });
  const { api } = loadModules();
  return api.request("/api/x").then(
    () => "resolved",
    (e: Error) => e.message,
  );
}

function streamFailsWith(errMsg: string): Promise<unknown> {
  installWx((opts: any) => {
    const task = {
      abort: () => {},
      onChunkReceived: () => {},
    };
    setTimeout(() => opts.fail({ errMsg }), 0);
    return task;
  });
  const { chat } = loadModules();
  return chat.streamChat({ task: "x", args: {} }).then(
    () => "resolved",
    (e: Error) => e.message,
  );
}

describe("网络层错误文案映射收口", () => {
  it("api.netErrMsg 已导出：abort 文案可按通道指定，缺省「请求已取消」", () => {
    const { api } = loadModules();
    expect(api.netErrMsg({ errMsg: "request:fail abort" }, "生成已停止")).toBe("生成已停止");
    expect(api.netErrMsg({ errMsg: "request:fail abort" })).toBe("请求已取消");
    expect(api.netErrMsg({ errMsg: "request:fail timeout" })).toBe("请求超时，请检查网络后重试");
    expect(api.netErrMsg({ errMsg: "request:fail domain list not in list" })).toBe(
      "当前网络无法访问服务，请检查网络",
    );
  });

  it("JSON 通道与流式通道：timeout 文案一致", async () => {
    expect(await requestFailsWith("request:fail timeout")).toBe("请求超时，请检查网络后重试");
    expect(await streamFailsWith("request:fail timeout")).toBe("请求超时，请检查网络后重试");
  });

  it("domain list 分支两条通道都在（漂移修复）", async () => {
    const copy = "当前网络无法访问服务，请检查网络";
    expect(await requestFailsWith("request:fail domain list not in list")).toBe(copy);
    expect(await streamFailsWith("request:fail domain list not in list")).toBe(copy);
  });

  it("流式通道 abort 显示「生成已停止」（有意为之的通道差异）", async () => {
    expect(await streamFailsWith("request:fail abort")).toBe("生成已停止");
  });
});
