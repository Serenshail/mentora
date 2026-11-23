import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { useAppStore } from "../store";

/* ============ 助手「存为笔记」必须消费 addKnowledge 的去重返回值（回归锁） ============
 * 背景：addKnowledge 按 title 全库去重、同名整条丢弃并返回**实际新增**条数
 * （store 接口注释点名要求调用方据此给真实反馈——这是要消灭的旧反模式）。
 * saveAsNote 不接返回值、无条件提示成功：对同一条回答点两次「存为笔记」
 * （或不同回答首行撞名）时第二条根本没入库，用户却看到成功提示。 */

const SRC = readFileSync(join(process.cwd(), "src/components/assistant-widget.tsx"), "utf8");

describe("store.addKnowledge 去重契约（被 saveAsNote 依赖）", () => {
  beforeEach(() => {
    useAppStore.setState({ knowledge: [], folders: [] });
  });

  it("同名真笔记整条丢弃：返回 0，库里仍是旧内容", () => {
    useAppStore.getState().addKnowledge([{ title: "协程与线程", body: "第一版", domain: "笔记" }], "manual", "AI 助手");
    const added = useAppStore.getState().addKnowledge([{ title: "协程与线程", body: "第二版", domain: "笔记" }], "manual", "AI 助手");
    expect(added).toBe(0);
    const matches = useAppStore.getState().knowledge.filter((k) => k.title === "协程与线程");
    expect(matches).toHaveLength(1);
    expect(matches[0].body).toBe("第一版");
  });

  it("新标题返回实际新增条数 1", () => {
    expect(useAppStore.getState().addKnowledge([{ title: "新笔记", body: "b", domain: "笔记" }], "manual", "AI 助手")).toBe(1);
  });
});

describe("saveAsNote 消费返回值（静态扫描）", () => {
  it("捕获返回值并区分「已存为笔记」与「已有同名笔记」两种反馈", () => {
    expect(SRC).toMatch(/const added = useAppStore\.getState\(\)\.addKnowledge\(/);
    expect(SRC).toMatch(/if \(added > 0\) toast\.success/);
    expect(SRC).toContain("已有同名笔记");
  });

  it("不再存在「无条件 addKnowledge 后直接报成功」的旧写法", () => {
    expect(SRC).not.toMatch(/addKnowledge\(\[\{ title, body: content, domain: "笔记" \}\], "manual", "AI 助手"\);\s*toast\.success/);
  });
});
