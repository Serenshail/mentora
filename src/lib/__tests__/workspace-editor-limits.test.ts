import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseWorkspace,
  workspaceBlockSchema,
  WORKSPACE_FIELD_LIMITS,
  WORKSPACE_PAGE_CHAR_LIMIT,
} from "../workspace";

/* ============ 个人页面编辑框长度防护 + 渲染/保存路径（回归锁） ============
 * 背景：markdown 编辑框没有与 schema 对齐的 maxLength——超 3 万字符的输入要到
 * changeBlock 保存时才被 zod 拒绝，报错误导（整页 180KB 的文案套在单字段上限上），
 * 用户点「完成」后没保存的输入一起丢掉。同时渲染路径每次全量 parseWorkspace，
 * changeBlock 每次编辑再连续两次全量校验（单次交互 3 次 stringify+深校验）。
 * vitest 无 DOM 环境，组件行为沿用仓库既有静态扫描做法（button-theme-tokens.test.ts）。 */

const PAGE = readFileSync(join(process.cwd(), "src/app/workspace/[id]/page.tsx"), "utf8");
const LIST = readFileSync(join(process.cwd(), "src/app/workspace/page.tsx"), "utf8");

describe("schema 与导出的字段/页面上限同源", () => {
  it("WORKSPACE_FIELD_LIMITS 与 schema 既有字面值一致（对齐 table 单元格的 5000 先例）", () => {
    expect(WORKSPACE_FIELD_LIMITS.markdownText).toBe(30000);
    expect(WORKSPACE_FIELD_LIMITS.tableCell).toBe(5000);
    expect(WORKSPACE_PAGE_CHAR_LIMIT).toBe(180000);
  });

  it("markdown text 恰好在上限处通过、超一字失败", () => {
    const block = (text: string) => ({ id: "b1", title: "笔记", type: "markdown" as const, text });
    expect(workspaceBlockSchema.safeParse(block("a".repeat(WORKSPACE_FIELD_LIMITS.markdownText))).success).toBe(true);
    expect(workspaceBlockSchema.safeParse(block("a".repeat(WORKSPACE_FIELD_LIMITS.markdownText + 1))).success).toBe(false);
  });

  it("整页超 180000 字符被拒（各块自身合法，只有 superRefine 的总量上限失败）", () => {
    const page = (n: number) => ({
      schemaVersion: 1,
      pinned: false,
      blocks: Array.from({ length: n }, (_, i) => ({
        id: `b${i}`,
        title: `块${i}`,
        type: "markdown" as const,
        text: "a".repeat(WORKSPACE_FIELD_LIMITS.markdownText),
      })),
    });
    expect(parseWorkspace(page(7))).toBeNull(); // 7×30000 ≈ 210k > 180k
    expect(parseWorkspace(page(5))).not.toBeNull(); // 5×30000 = 150k < 180k
  });
});

describe("详情页：maxLength 对齐、增量校验、共享 Button", () => {
  it("markdown 编辑框与表格单元格的 maxLength 都引用同一份常量，不再出现写死数字", () => {
    expect(PAGE).toContain("maxLength={WORKSPACE_FIELD_LIMITS.markdownText}");
    expect(PAGE).toContain("maxLength={WORKSPACE_FIELD_LIMITS.tableCell}");
    expect(PAGE).not.toMatch(/maxLength=\{\d+\}/);
  });

  it("保存路径：复用渲染期校验结果 + 被编辑块的增量校验 + 页面总量校验", () => {
    expect(PAGE).toContain("current?.workspace === note.workspace ? workspace : parseWorkspace(current?.workspace)");
    expect(PAGE).toContain("workspaceBlockSchema.safeParse(updated)");
    expect(PAGE).toContain("JSON.stringify({ ...data, blocks }).length > WORKSPACE_PAGE_CHAR_LIMIT");
    expect(PAGE).toContain('toast.error("内容超出当前页面容量，请拆为多个页面")');
  });

  it("渲染路径按 workspace 内容 memo（编辑开关/无关更新不再全量 parse）", () => {
    expect(PAGE).toContain("useMemo(() => parseWorkspace(note?.workspace), [note?.workspace])");
  });

  it("添加一行/固定到侧栏走共享 Button：300 行封顶拿到 disabled:opacity-45 反馈", () => {
    expect(PAGE).toContain('import { Button } from "@/components/ui"');
    expect(PAGE).toMatch(/<Button\s+variant="outline"\s+className="mt-3"\s+disabled=\{block\.rows\.length >= 300\}/);
    expect(PAGE).toMatch(/<Button\s+variant="outline"\s+onClick=\{\(\) =>\s+useAppStore\.getState\(\)\.updateKnowledge\(id, \{ workspace/);
  });
});

describe("列表页：合法性过滤按 knowledge 缓存", () => {
  it("过滤放进 useMemo：水合翻转/无关状态变化不再对全部笔记重跑 parseWorkspace", () => {
    expect(LIST).toContain("const pages = useMemo(() => knowledge.filter((n) => parseWorkspace(n.workspace)), [knowledge]);");
    /* parseWorkspace 只允许出现在 memo 内，不得在渲染体里散落重跑 */
    expect((LIST.match(/parseWorkspace\(/g) ?? []).length).toBe(1);
  });
});
