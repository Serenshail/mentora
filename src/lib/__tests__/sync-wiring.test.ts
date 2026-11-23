import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ 三条同步写入路径必须共用同一个决策函数（复核 §2） ============
 * 复核原话：现有测试「主要检查源码文字，不能证明这些行为安全」。
 *
 * 本文件里：
 *  - **行为断言**放在 sync-decision.test.ts（18 条，直接测纯函数的输入输出）；
 *  - 本文件只负责证明**三条真实路径确实调用了那个纯函数**，而不是各自写一套判断。
 *    这是「接线正确性」，不是「行为正确性」——两者分开写，避免再用正则冒充行为证据。 */

const src = readFileSync(fileURLToPath(new URL("../auth-client.ts", import.meta.url)), "utf8");

/** 抽出某个函数的函数体（花括号配平） */
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

describe("接线：三条路径共用 decideSyncAction", () => {
  it("bootSync 调用 decideSyncAction，且返回三态之一", () => {
    expect(fnBody("export async function bootSync")).toMatch(/bootSyncForAccount\(/);
    const body = fnBody("async function bootSyncForAccount");
    expect(body).toMatch(/decideSyncAction\(/);
    expect(body).toMatch(/return "ready"/);
    expect(body).toMatch(/return "unsafe"/);
  });

  it("syncAfterLogin 调用 decideSyncAction（不再用 store 引用变化决定推送）", () => {
    const body = fnBody("export async function syncAfterLogin");
    expect(body).toMatch(/decideSyncAction\(/);
    expect(body).toMatch(/businessFingerprint\(/);
    /* 反向断言：不得再用 getState() !== stateBeforePull 这种恒真判断 */
    expect(body).not.toMatch(/useAppStore\.getState\(\) !== stateBeforePull/);
  });

  it("bootSync 用业务指纹而不是引用比较判断「拉取期间被编辑」", () => {
    const body = fnBody("async function bootSyncForAccount");
    expect(body).toMatch(/businessFingerprint\(/);
    expect(body).not.toMatch(/useAppStore\.getState\(\) !== stateBeforePull/);
  });
});

describe("接线：useAutoPush / useFlushOnHide 都必须等 bootSync 报告 ready", () => {
  it("useAutoPush 只在 result === 'ready' 时放行", () => {
    const body = fnBody("export function useAutoPush");
    expect(body).toMatch(/result = await bootSync\(\)/);
    expect(body).toMatch(/result === "ready"/);
    expect(body).toMatch(/if \(!ready\) return;/);
  });

  it("useFlushOnHide 也加了同一闸门（复核 §2-2：原实现完全绕过）", () => {
    const body = fnBody("export function useFlushOnHide");
    expect(body).toMatch(/result = await bootSync\(\)/);
    expect(body).toMatch(/result === "ready"/);
    expect(body).toMatch(/if \(!ready \|\| !readLocalEditMarker\(\)\) return;/);
  });

  it("useFlushOnHide 卸载时取消，避免 unmount 后仍放行", () => {
    const body = fnBody("export function useFlushOnHide");
    expect(body).toMatch(/cancelled = true/);
  });
});

describe("反例：不得再出现「拉取失败也推送」的写法", () => {
  it("bootSync 里 error 分支不得调用 pushCloud", () => {
    const body = fnBody("export async function bootSync");
    /* error 的处理在纯函数里返回 none；这里只确认 bootSync 没有在 catch 里推送 */
    const catchPart = body.slice(body.lastIndexOf("} catch"));
    expect(catchPart).not.toMatch(/pushCloud/);
  });

  it("syncAfterLogin 里不得在检查 error 之前 pushCloud", () => {
    const body = fnBody("export async function syncAfterLogin");
    const pushIdx = body.indexOf("await pushCloud({ baseVersion:");
    const decisionIdx = body.indexOf("decideSyncAction(");
    expect(pushIdx).toBeGreaterThan(decisionIdx); // 推送必须发生在决策之后
  });
});
