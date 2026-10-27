import { describe, expect, it } from "vitest";
import { splitGoalReply } from "../ai/client";

const card = {
  topic: "Python",
  direction: "能用 Python 接收硬件数据并导入数据库",
  domainKind: "coding",
  motivation: "实现硬件数据接收，并导入到学校的库里",
  background: "缺少 Python 数据处理能力",
  weeklyHours: 6,
  learnerProfile: ["每周约 6 小时"],
  successCriteria: ["能用 Python 从串口接收数据"],
  assumptions: ["先按数据库表理解学校库"],
};

describe("splitGoalReply", () => {
  it("有 GOAL_READY 标记时只保留标记前的正文", () => {
    const text = `你的画像和目标如下。\n<!--GOAL_READY-->\n\`\`\`json\n${JSON.stringify(card)}\n\`\`\``;
    const r = splitGoalReply(text);
    expect(r.card?.topic).toBe("Python");
    expect(r.prose).toBe("你的画像和目标如下。");
  });

  it("模型漏掉标记、只给 json 围栏时也能解析，并把 json 从正文剔除", () => {
    const text = `明白，先按已有信息出卡。\n\`\`\`json\n${JSON.stringify(card)}\n\`\`\``;
    const r = splitGoalReply(text);
    expect(r.card?.weeklyHours).toBe(6);
    expect(r.prose).toBe("明白，先按已有信息出卡。");
    expect(r.prose).not.toContain("```");
  });

  it("没有围栏光秃秃 json 也能解析", () => {
    const r = splitGoalReply(JSON.stringify(card));
    expect(r.card?.topic).toBe("Python");
    expect(r.prose).toBe("");
  });

  it("纯聊天回复不误判，原样返回", () => {
    const text = "先说说你说的硬件接口是什么型号？";
    const r = splitGoalReply(text);
    expect(r.card).toBeNull();
    expect(r.prose).toBe(text);
  });
});
