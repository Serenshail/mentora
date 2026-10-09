import { describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/* prompts.ts 是服务端模块（import "server-only"），在 vitest 里需要豁免该护栏 */
vi.mock("server-only", () => ({}));

import { PERSONAS, CONCEPT_PERSONAS, personaById } from "../ai/prompts";
import { PERSONA_SEATS, CONCEPT_SEATS, seatById, ALL_SEAT_METAS } from "../ai/persona-meta";

/* ============ 防复刻回归锁 ============
 * 背景：12 个人物席 + 4 个认知工具席的完整 system 提示词是产品核心资产。
 * 它们只允许存在于 prompts.ts（server-only）；前端只拿 persona-meta.ts 的展示元数据。
 * 1) persona-meta 与 prompts 的元数据必须逐字段一致（漂移即红）；
 * 2) 任何含 "use client" 的文件都不得 import ai/prompts（静态扫描）。 */
describe("席位元数据双源一致（persona-meta ↔ prompts）", () => {
  it("人物席：id 序列与展示字段逐一对应", () => {
    expect(PERSONA_SEATS.map((m) => m.id)).toEqual(PERSONAS.map((p) => p.id));
    for (const m of PERSONA_SEATS) {
      const full = PERSONAS.find((p) => p.id === m.id)!;
      expect({ name: full.name, tag: full.tag, bio: full.bio, color: full.color }).toEqual({
        name: m.name, tag: m.tag, bio: m.bio, color: m.color,
      });
    }
  });

  it("认知工具席：id 序列与展示字段逐一对应", () => {
    expect(CONCEPT_SEATS.map((m) => m.id)).toEqual(CONCEPT_PERSONAS.map((p) => p.id));
    for (const m of CONCEPT_SEATS) {
      const full = CONCEPT_PERSONAS.find((p) => p.id === m.id)!;
      expect({ name: full.name, tag: full.tag, bio: full.bio, color: full.color }).toEqual({
        name: m.name, tag: m.tag, bio: m.bio, color: m.color,
      });
    }
  });

  it("服务端 personaById 能解析每一个前端可见席位，且 system 非空", () => {
    for (const m of ALL_SEAT_METAS) {
      expect(personaById(m.id)?.system.length).toBeGreaterThan(50);
      expect(seatById(m.id)).toBe(m);
    }
    expect(personaById("不存在的席位")).toBeUndefined();
  });

  it("persona-meta 绝不含 system 字段（前端包里没有配方）", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/ai/persona-meta.ts"), "utf8");
    expect(src).not.toMatch(/^\s*system\s*:/m);
  });
});

describe("提示词中枢不进入客户端图", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };

  it("src/app 下没有任何客户端文件 import @/lib/ai/prompts", () => {
    const offenders = walk(join(process.cwd(), "src/app"))
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        return text.includes(`"use client"`) && /from\s+["']@\/lib\/ai\/prompts["']/.test(text);
      });
    expect(offenders).toEqual([]);
  });
});
