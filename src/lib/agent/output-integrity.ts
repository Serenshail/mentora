/* 输出完整性检查（第二轮复核 Q03 指出的截断/残片）
 *
 * 现场：Q03 的归档尾部出现 `if (tmp !---` 和未闭合强调——正文被截断或被清洗规则破坏。
 * hash 正确只证明「存下来的这段是完整的文本」，**不证明语义完整**。
 *
 * 这里做确定性检查（不调模型），产出「可疑残片」清单：
 *  - 未闭合的代码围栏（``` 奇数个）
 *  - 未闭合的行内强调（** 或 __ 奇数个）
 *  - 末尾悬空的运算符/关键字（如 `if (tmp !`、`&&`、`+`）
 *  - 明显被削掉的代码片段（以 `---` 或 `--` 结尾的 C/JS 片段）
 *
 * 用途：runner 在落库前检查一次；不合格时**不删内容**，而是在 meta 里标记
 * `integrity: "suspect"` 并给出原因，让 UI/证据如实呈现（不伪造完整）。
 */

export interface IntegrityIssue {
  kind: "unclosed-fence" | "unclosed-emphasis" | "dangling-tail" | "truncated-code" | "unsafe-allocation";
  detail: string;
}

export interface IntegrityReport {
  ok: boolean;
  issues: IntegrityIssue[];
}

/** 统计某个标记在正文（排除代码块内部）出现次数是否为奇数。 */
function oddCountOutsideFences(text: string, marker: string): number {
  const parts = text.split(/(```[\s\S]*?(?:```|$))/g);
  let n = 0;
  for (let i = 0; i < parts.length; i += 2) {
    /* 偶数下标 = 围栏外的正文 */
    const seg = parts[i] ?? "";
    n += seg.split(marker).length - 1;
  }
  return n;
}

export function checkOutputIntegrity(text: string): IntegrityReport {
  const issues: IntegrityIssue[] = [];
  if (!text || !text.trim()) return { ok: true, issues };
  for(const block of text.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)){
    if(!/^(?:c|cpp|c\+\+)?$/.test(block[1].trim()))continue;
    const before=text.slice(Math.max(0,(block.index??0)-140),block.index);
    if(/错误示例|错误写法|错误模式|不要这样写|反例|自测|练习题|(?:仍然|依然)(?:是)?错的/.test(before))continue;
    const code=block[2].replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,"");
    for(const allocation of code.matchAll(/\b(\w+)\s*=\s*realloc\(\s*(\w+)/g)){
      const [,temporary,original]=allocation;
      const guard=new RegExp(`if\\s*\\(\\s*(?:!${temporary}|${temporary}\\s*==\\s*NULL|NULL\\s*==\\s*${temporary})\\s*\\)\\s*\\{([^{}]*)\\}\\s*${original}\\s*=\\s*${temporary}\\s*;`);
      const failure=guard.exec(code);
      if(failure&&!/\b(?:return|goto|exit|abort|longjmp)\b/.test(failure[1])){
        issues.push({kind:"unsafe-allocation",detail:"有一段 realloc 示例在失败分支后仍会覆盖原指针；该示例不能直接使用，需要先修正控制流"});
      }
    }
  }

  /* 1) 未闭合围栏：``` 出现奇数次 */
  const fences = (text.match(/```/g) ?? []).length;
  if (fences % 2 === 1) {
    issues.push({ kind: "unclosed-fence", detail: `代码围栏出现 ${fences} 次（奇数，有未闭合块）` });
  }

  /* 2) 未闭合强调：** 在围栏外出现奇数次 */
  const bold = oddCountOutsideFences(text, "**");
  if (bold % 2 === 1) {
    issues.push({ kind: "unclosed-emphasis", detail: `加粗标记 ** 出现 ${bold} 次（奇数，有未闭合）` });
  }

  /* 3) 末尾悬空：最后一行以运算符/不完整片段收尾 */
  const tail = text.trimEnd().split("\n").pop() ?? "";
  const dangling =
    /(?:[+\-*/%&|=<>!?:,.([]|&&|\|\|)$/.test(tail.trim()) ||
    /\b(?:if|while|for|return|sizeof|struct|int|char|void|const)\s*\(?\s*$/.test(tail.trim()) ||
    /--$/.test(tail.trim());
  if (dangling && tail.trim().length > 0) {
    issues.push({ kind: "dangling-tail", detail: `末行疑似被截断：「${tail.trim().slice(-40)}」` });
  }

  /* 4) 明显被削的代码片段：以 `---` 结尾且含 C 关键字 */
  if (/---\s*$/.test(tail.trim()) && /\b(?:if|for|while|int|char|void|return)\b/.test(text.slice(-200))) {
    issues.push({ kind: "truncated-code", detail: `代码片段以 --- 收尾，疑似被削断：「${tail.trim().slice(-40)}」` });
  }

  return { ok: issues.length === 0, issues };
}

/** 给 UI/证据用的一句话说明（不隐藏问题，也不夸大）。 */
export function integrityNote(report: IntegrityReport): string | null {
  if (report.ok) return null;
  return `${report.issues.some(i=>i.kind==="unsafe-allocation")?"这段回答有示例安全问题":"这段回答可能有残缺"}：${report.issues.map((i) => i.detail).join("；")}。内容已按原样保留，未被修补。`;
}
