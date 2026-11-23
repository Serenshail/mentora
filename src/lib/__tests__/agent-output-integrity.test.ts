import { describe, expect, it } from "vitest";
import { checkOutputIntegrity, integrityNote } from "../agent/output-integrity";

/* ============ 输出完整性（第二轮复核 Q03 的截断/残片） ============
 * 现场：Q03 归档尾部出现 `if (tmp !---` 与未闭合强调。
 * hash 正确 ≠ 语义完整，这里锁住「能识别出可疑残片」。 */

describe("输出完整性检查", () => {
  it("所谓安全示例的失败分支只有注释却继续覆盖指针，应报安全问题",()=>{
    const code="安全模式：\n```c\nint *tmp = realloc(a, n * sizeof *a);\nif (tmp == NULL) { /* return on error */ }\na = tmp;\n```";
    expect(checkOutputIntegrity(code).issues.some(i=>i.kind==="unsafe-allocation")).toBe(true);
  });
  it("有真实 return 的失败分支不误报；明确标为错误示例时保留教学对比",()=>{
    const code="```c\nint *tmp = realloc(a, n * sizeof *a);\nif (!tmp) { return 1; }\na = tmp;\n```";
    expect(checkOutputIntegrity(code).ok).toBe(true);
    const bad="错误示例：\n```c\nint *tmp = realloc(a, n);\nif (!tmp) {}\na=tmp;\n```";
    expect(checkOutputIntegrity(bad).issues.some(i=>i.kind==="unsafe-allocation")).toBe(false);
  });
  it("前面存在 text 输出围栏时仍能检查后面的C代码，不把闭合围栏当新代码块",()=>{
    const code="```text\n10 20 30\n```\n\n安全写法：\n```c\nint *t=realloc(p,n);\nif(!t) { /* 失败 */ }\np=t;\n```";
    expect(checkOutputIntegrity(code).issues.some(i=>i.kind==="unsafe-allocation")).toBe(true);
  });
  it("明确写着仍然是错的对比例子不被误判成推荐示例",()=>{
    const code="下面这段**仍然是错的**：\n```c\nint *tmp=realloc(p,n);\nif(tmp==NULL){ /* 应该处理失败 */ }\np=tmp;\n```";
    expect(checkOutputIntegrity(code).ok).toBe(true);
  });
  it("正常完整回答 → ok", () => {
    const r = checkOutputIntegrity("结论：用临时指针。\n\n```c\nint *tmp = realloc(d, n);\nif (!tmp) return 0;\nd = tmp;\n```\n\n完。");
    expect(r.ok).toBe(true);
  });

  it("未闭合代码围栏 → 报 unclosed-fence", () => {
    const r = checkOutputIntegrity("看这段：\n\n```c\nint *tmp = realloc(d, n);");
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.kind === "unclosed-fence")).toBe(true);
  });

  it("未闭合加粗 → 报 unclosed-emphasis", () => {
    const r = checkOutputIntegrity("这是**重要的一点，后面没闭合。\n\n正常段落。");
    expect(r.issues.some((i) => i.kind === "unclosed-emphasis")).toBe(true);
  });

  it("末尾悬空运算符 → 报 dangling-tail", () => {
    const r = checkOutputIntegrity("结论如下：\n\nif (tmp !");
    expect(r.issues.some((i) => i.kind === "dangling-tail")).toBe(true);
  });

  it("代码以 --- 收尾 → 报 truncated-code", () => {
    const r = checkOutputIntegrity("int *tmp = realloc(d, n);\nif (tmp !---");
    expect(r.issues.some((i) => i.kind === "truncated-code" || i.kind === "dangling-tail")).toBe(true);
  });

  it("代码块内部的 ** 不算未闭合强调（避免误报）", () => {
    const r = checkOutputIntegrity("看：\n\n```c\nint **pp = &p;  // 双指针\n```\n\n完。");
    expect(r.issues.some((i) => i.kind === "unclosed-emphasis")).toBe(false);
  });

  it("空回答不报错（空是上游问题，不是残缺）", () => {
    expect(checkOutputIntegrity("").ok).toBe(true);
  });

  it("integrityNote 如实说明且强调「未被修补」", () => {
    const r = checkOutputIntegrity("这是**未闭合");
    const note = integrityNote(r);
    expect(note).toMatch(/可能有残缺/);
    expect(note).toMatch(/按原样保留，未被修补/);
  });
});
