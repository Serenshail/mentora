import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* 回归锁（2026-11 复核）：debug/provider-count 曾直接 import 另一个路由模块
 * （906 行的 chat/route.ts）只为读 getProviderAttempts 一个计数器。路由文件是 Next.js
 * 的构建入口而非可复用模块——那会把 chat 路由的整个依赖图（AI providers/prompts/
 * demo/agent-tools…）拉进 debug 端点的模块图，且计数器的唯一权威代码住在路由文件里，
 * 将来拆分/重构 chat 路由会静默破坏此端点。本仓惯例：共享逻辑下沉到 lib/（如 logEvent
 * 在 config.ts）。修复：计数器下沉 lib/server/provider-attempts.ts，两端各自 import。 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("provider-count 不得 import 聊天路由模块", () => {
  it("debug/provider-count 从 lib/server/provider-attempts 读计数器，不再 import chat 路由", () => {
    const src = read("../../app/api/debug/provider-count/route.ts");
    expect(src).not.toMatch(/@\/app\/api\/chat\/route/);
    expect(src).toMatch(/import \{ getProviderAttempts \} from "@\/lib\/server\/provider-attempts"/);
  });

  it("计数器的权威实现在 lib/server/provider-attempts.ts，chat 路由只消费 noteProviderAttempt", () => {
    const lib = read("../../lib/server/provider-attempts.ts");
    expect(lib).toMatch(/export function noteProviderAttempt/);
    expect(lib).toMatch(/export function getProviderAttempts/);
    const chat = read("../../app/api/chat/route.ts");
    expect(chat).toMatch(/import \{ noteProviderAttempt \} from "@\/lib\/server\/provider-attempts"/);
    /* 计数器状态与键封顶逻辑不得再住在路由文件里（防将来反向漂移回去） */
    expect(chat).not.toMatch(/const providerAttempts = /);
    expect(chat).not.toMatch(/BYTASK_MAX_KEYS/);
  });
});
