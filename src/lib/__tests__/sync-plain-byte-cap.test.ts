import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* 回归锁：sync GET 的 plain=1 明文体积闸必须按 UTF-8 字节计量。
 * body 是 JSON 字符串，`body.length` 是 UTF-16 码元数；中文为主的内容在 UTF-8 下
 * 每字 3 字节，用码元数当字节闸会让 4.2MB 的闸实际放行约 12MB 明文响应。
 * 写侧（POST 的 JSON 分支）早已用 Buffer.byteLength(txt)，两侧须同口径。 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("源码护栏：sync 明文通道体积闸口径", () => {
  const src = read("../../app/api/sync/route.ts");
  const getSrc = src.slice(src.indexOf("export async function GET"), src.indexOf("export async function POST"));
  const postSrc = src.slice(src.indexOf("export async function POST"));

  it("GET plain=1 闸用 Buffer.byteLength(body, \"utf8\")", () => {
    expect(getSrc).toMatch(/plain\s*&&\s*Buffer\.byteLength\(body,\s*"utf8"\)\s*>\s*MAX_BODY_BYTES/);
  });

  it("GET plain=1 闸不得回退到 body.length 码元数", () => {
    expect(getSrc).not.toMatch(/plain\s*&&\s*body\.length\s*>\s*MAX_BODY_BYTES/);
  });

  it("写侧 JSON 分支仍按 UTF-8 字节计量（同口径）", () => {
    expect(postSrc).toContain('Buffer.byteLength(txt) > MAX_BODY_BYTES');
  });
});

describe("计量口径实测（UTF-16 码元 vs UTF-8 字节）", () => {
  it("中文快照的字节数显著高于码元数（JSON 结构字符为 ASCII，会稀释比例）", () => {
    // 真实快照以笔记正文为主：正文越长，ASCII 结构开销占比越低，比例越接近 3 倍
    const body = JSON.stringify({
      data: { knowledge: Array.from({ length: 50 }, () => ({ body: "中文内容示例".repeat(100) })) },
    });
    const units = body.length;
    const bytes = Buffer.byteLength(body, "utf8");
    expect(bytes).toBeGreaterThan(units * 2.5); // 正文为主时实测约 2.9 倍
  });

  it("4.2MB 码元的中文响应实际超过 4.2MB 字节闸", () => {
    const cap = 4.2 * 1024 * 1024;
    const body = "中".repeat(Math.ceil(cap / 1)); // 码元数约等于闸值
    expect(body.length).toBeLessThanOrEqual(cap + 1); // 旧口径会放行
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(cap); // 新口径拒绝
  });
});
