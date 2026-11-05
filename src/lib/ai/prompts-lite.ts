/* 提示词相关的纯判定（可被客户端引用；prompts.ts 是 server-only，不能进浏览器包） */

/** 是否进入"深度讲解"模式：带图片，或用户明确要求讲解/分析材料 */
export function wantsDeepExplanation(text: string, hasImage = false): boolean {
  if (hasImage) return true;
  return /详细|逐行|逐句|讲解|讲一下|剖析|解释一下|分析一下|拆解|拆一下|看不懂|怎么理解|怎么运作|什么意思|讲讲|说说这|这段代码|这道题|这篇文章|这本书|这一章/.test(
    text
  );
}
