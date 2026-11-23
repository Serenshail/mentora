import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { READING_MODES } from "../ai/reading-modes";
import { ALL_SEAT_METAS } from "../ai/persona-meta";

/* ============ 用户可见文案的中文标点一致性锁 ============
 * 背景：阅读模式选择弹窗（read/[id]/page.tsx 渲染 {m.hint}）与圆桌席位卡
 * （council/page.tsx 渲染 bio）曾混用半角 , : ;，与同弹窗标题/toast 的全角风格
 * 不一致，中文语境下渲染局促、观感像错别字。小程序端 modes.js/seats.js 已是全角。
 * 这里只锁「用户直接读到的展示字段」，不锁代码注释与提示词正文。 */

/** 中文字符紧邻半角 , : ; —— 中文语境下应使用全角 ，：； */
const HALF_WIDTH_BETWEEN_CJK = /[\u4e00-\u9fff][,:;]|[,:;][\u4e00-\u9fff]/;

const collectBad = (entries: { field: string; value: string }[]) =>
  entries.filter((e) => HALF_WIDTH_BETWEEN_CJK.test(e.value)).map((e) => `${e.field}: ${e.value}`);

describe("用户可见文案不使用半角 , : ;", () => {
  it("阅读五模式的 label/hint/forType 全为全角标点", () => {
    const entries = READING_MODES.flatMap((m) => [
      { field: `${m.id}.label`, value: m.label },
      { field: `${m.id}.hint`, value: m.hint },
      { field: `${m.id}.forType`, value: m.forType },
    ]);
    expect(collectBad(entries)).toEqual([]);
  });

  it("圆桌席位（人物席 + 认知工具席）的 name/tag/bio 全为全角标点", () => {
    const entries = ALL_SEAT_METAS.flatMap((s) => [
      { field: `${s.id}.name`, value: s.name },
      { field: `${s.id}.tag`, value: s.tag },
      { field: `${s.id}.bio`, value: s.bio },
    ]);
    expect(collectBad(entries)).toEqual([]);
  });

  it("小程序端同源文案保持全角（modes.js / seats.js 源文本扫描）", () => {
    for (const rel of ["miniprogram/utils/modes.js", "miniprogram/utils/seats.js"]) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      const literals = [...src.matchAll(/(?:hint|label|forType|name|tag|bio):\s*"([^"]*)"/g)].map((m) => m[1]!);
      expect(collectBad(literals.map((v, i) => ({ field: `${rel}#${i}`, value: v })))).toEqual([]);
    }
  });
});
