import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ QuickNotes 撞标题去重必须如实反馈（回归锁） ============
 * 背景：store.addKnowledge 按 title 全库去重（同名整条丢弃）且原来返回 void——
 * 调用方无法得知是否被丢弃；QuickNotes 调用后无条件 toast.success("已记入第二大脑")
 * 并清空输入。随手记标题取前 40 字符，极易与验收通过时以知识点原文为标题写入的
 * 笔记撞车：用户的笔记实际未保存却收到成功确认（带假反馈的静默丢数据）。
 *
 * 修复：addKnowledge 返回实际新增条数；QuickNotes 消费返回值——新增 >0 才清空输入
 * 并报成功，被去重丢弃时如实报错并保留输入。 */

const STORE = readFileSync(
  fileURLToPath(new URL("../../lib/store.ts", import.meta.url)),
  "utf8"
);
const PAGE = readFileSync(
  fileURLToPath(new URL("../../app/learn/[id]/page.tsx", import.meta.url)),
  "utf8"
);

describe("store.addKnowledge：返回实际新增条数（去重不再静默）", () => {
  it("接口签名是 => number", () => {
    expect(STORE).toMatch(/sourceTitle: string\s*\n\s*\) => number;/);
  });

  it("实现返回 fresh.length（被去重丢弃的条数不计入）", () => {
    const impl = STORE.slice(
      STORE.indexOf("addKnowledge: (items, source, sourceTitle) => {"),
      STORE.indexOf("createKnowledge: (init) =>")
    );
    expect(impl).toMatch(/return fresh\.length;/);
    expect(impl).toMatch(/\.filter\(\(i\) => i\.title && !existing\.has\(i\.title\)\)/);
  });
});

describe("learn/[id] QuickNotes：消费返回值，撞名不再假成功", () => {
  const quick = PAGE.slice(
    PAGE.indexOf("function QuickNotes"),
    PAGE.indexOf("/* ================= 页面")
  );

  it("调用 addKnowledge 时接收返回值", () => {
    expect(quick).toMatch(/const added = addKnowledge\(/);
  });

  it("新增 >0 才清空输入并报成功；else 分支如实报错", () => {
    expect(quick).toMatch(
      /if \(added > 0\) \{\s*\n\s*setText\(""\);\s*\n\s*toast\.success\("已记入第二大脑"\);\s*\n\s*\} else \{/
    );
    expect(quick).toMatch(/toast\.error\("第二大脑里已有同名笔记/);
  });

  it("撞名被丢弃时不清空输入（用户的话不丢）", () => {
    const elseIdx = quick.indexOf("} else {");
    const elseBlock = quick.slice(elseIdx, quick.indexOf("}}", elseIdx));
    expect(elseBlock).not.toContain('setText("")');
  });
});
