/** 从 LLM 输出中稳健提取 JSON（容忍 ```json 围栏 / 前后缀文本）。
 *
 *  独立纯模块（v27 · 插件重构 M2）：此前住在 client.ts，但插件侧（vault-home）
 *  需要与产品逐字同算法的提取器——scripts/gen-plugin-shared.mjs 从本文件生成
 *  plugin-src/30-gen-json.js，两端单一真源。本文件必须保持零依赖纯函数。 */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  // 大括号/中括号配对扫描（跳过字符串内部）
  const scanned: { start: number; text: string }[] = [];
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = text.indexOf(open);
    if (start === -1) continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    // 记录起点,后面按"在原文中出现最早"排序——裸数组 "[{...}]" 时先命中整个数组而非首个对象
    if (end > start) scanned.push({ start, text: text.slice(start, end + 1) });
  }
  scanned.sort((a, b) => a.start - b.start);
  for (const s of scanned) candidates.push(s.text);
  candidates.push(text.trim());

  /* 弱候选 = 纯数字/短数字串数组，如正文里的引用标记 [1]、[2]。
   * 模型没按提示词加 ``` 围栏、而散文里带「根据资料[1]，…」时，"[1]" 出现最早、
   * parse 必然成功，会抢在真 JSON 之前被返回（上游 schema.parse 必抛错）。
   * 故两趟尝试：先跳过弱候选，全失败后再兜底试它们——真输出本来就是 [1] 时行为不变。 */
  const isWeak = (c: string): boolean => {
    try {
      const v: unknown = JSON.parse(c);
      return (
        Array.isArray(v) &&
        v.length > 0 &&
        v.every((x) => typeof x === "number" || (typeof x === "string" && /^\d{1,4}$/.test(x)))
      );
    } catch {
      return false;
    }
  };

  for (const weakPass of [false, true]) {
    for (const c of candidates) {
      if (isWeak(c) !== weakPass) continue;
      try {
        return JSON.parse(c) as T;
      } catch { /* try next */ }
    }
  }
  throw new Error("无法从模型输出中解析 JSON");
}
