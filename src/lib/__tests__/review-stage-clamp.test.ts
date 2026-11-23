import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ toFsrsCard：reviewStage 必须夹到 [0,4]（防主线程挂死）============
 * 历史缺陷：`for (let i = 0; i < k.reviewStage; i++) FSRS.repeat(...)`。运行时所有写入点
 * 都有界（stageOf 封顶 4、reviewPatch 只写 0/-1），但 sanitizeBackup 用 `...k` 原样放行
 * knowledge 的数值字段——一份 reviewStage:1e7 的导入备份（或 localStorage 被改）会让这里
 * 同步跑千万次 FSRS，主线程永久挂死、标签页无响应且应用内无自救入口。
 * 该缺陷是「同步无界循环」，行为型测试无法在不拖死 worker 的前提下断言（vitest 超时
 * 打断不了同步循环），故沿用本仓库既有的静态扫描做法（见 cmdk-note-index.test.ts）。 */

const STORE = readFileSync(fileURLToPath(new URL("../../lib/store.ts", import.meta.url)), "utf8");

describe("store.toFsrsCard：reviewStage 有界", () => {
  const fn = STORE.slice(STORE.indexOf("function toFsrsCard("), STORE.indexOf("function stageOf("));

  it("循环上界是夹到 [0,4] 的值，而不是原始 reviewStage", () => {
    expect(fn).toMatch(/Math\.min\(4, Math\.max\(0, Math\.floor\(k\.reviewStage\)\)\)/);
    expect(fn).toMatch(/for \(let i = 0; i < preheat; i\+\+\)/);
    expect(fn).not.toMatch(/i < k\.reviewStage/);
  });
});
