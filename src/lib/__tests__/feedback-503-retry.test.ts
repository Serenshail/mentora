import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* 反馈 503（服务端缺 GITHUB_TOKEN）分类回归锁。
 * 背景：/api/feedback 仅在 !GITHUB_TOKEN 时返回 503（route.ts:33-40），是部署配置
 * 问题而非用户侧确定性失败——重启/重新部署丢 env 即可触发，运营者随时可修好。
 * 若把 503 归入 fatal：当场提交者被误导为「服务端拒收——请精简内容」（400 才是
 * 内容问题），队列里已存下的反馈在下次挂载重试时直接 removeOne 永久删除（单向
 * 通道，删了就没了）。本锁确保 503 只走 retry 排队，fatal 仅留给内容类 400。
 * 仓库无 jsdom/@testing-library（见 rt-retry-clear.test.ts），沿用源码扫描护栏风格。 */

const src = readFileSync(
  fileURLToPath(new URL("../../components/feedback-widget.tsx", import.meta.url)),
  "utf8"
);

/** send() 函数体：ok/fatal/retry 三态判定都在这里 */
const sendBody = src.match(/const send = async \(fb: PendingFeedback\)([\s\S]*?)\n  \};/)?.[1];

describe("反馈 503（缺 GITHUB_TOKEN）不得当永久失败丢弃", () => {
  it("send() 的 fatal 判定只认 400，503 不得归入 fatal", () => {
    expect(sendBody, "未能定位 send() 函数体").toBeTruthy();
    const fatalLine = sendBody!.match(/if \(([^\n]*)\) return "fatal";/)?.[1] ?? "";
    expect(fatalLine, "fatal 判定行必须存在").toBeTruthy();
    expect(fatalLine).toMatch(/400/);
    expect(fatalLine).not.toMatch(/503/); // 核心：503 不是确定性失败
    expect(fatalLine).not.toMatch(/\|\|/); // 不得再把其他状态码并进 fatal
  });

  it("send() 在 400 之外的非成功响应落到 retry（503/其他 5xx/429/网络都排队）", () => {
    expect(sendBody, "未能定位 send() 函数体").toBeTruthy();
    // fatal 判定之后紧接兜底 return "retry"，中间不得插入别的 fatal 分支
    expect(sendBody!).toMatch(/return "fatal";\s*\n\s*return "retry";/);
    expect(sendBody!).toMatch(/catch \{[\s\S]*?return "retry";/);
  });

  it("fatal 仍立即移出队列、retry 仍走 tries 计数（400 的止损语义不被破坏）", () => {
    // 确认修复只改分类，没有动 retry 循环里既有的两条消费路径
    expect(src).toMatch(/r === "fatal"[\s\S]{0,80}?removeOne\(fb\)/);
    expect(src).toMatch(/bumpTries\(fb\)/);
  });
});
