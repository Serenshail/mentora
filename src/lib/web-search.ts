export interface WebHit {
  title: string;
  url: string;
  snippet: string;
}

export async function searchPublicWeb(query: string, signal?: AbortSignal): Promise<WebHit[]> {
  const timeout = AbortSignal.timeout(27_000);
  const res = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw new Error("联网搜索暂时不可用");
  const data = await res.json() as { results: WebHit[] };
  return data.results.filter((hit) => /^https?:\/\/[^\s<>()]+$/i.test(hit.url)).slice(0, 6);
}

export async function councilEvidence(question: string, signal?: AbortSignal, onSearch?: () => void) {
  if (!/今日|今天|昨天|本周|近期|最近|最新|实时|现在|目前|新闻|联网|搜[索查一下]|查[查找一下]|[0-9]{2,4}年|分数线|录取线|哪些学校|行情|价格|current|latest|today|recent|news/i.test(question)) {
    return { evidence: "", sources: "" };
  }
  try {
    const query = question
      .replace(/^(?:针对|请|帮我|能帮我|联网|搜索|查一下|查查)+[：:\s]*/u, "")
      .replace(/[，,、。！？!?：:]*\s*(?:你们?有(?:什么|何)看法|你怎么看|怎么看|我可以选择哪些学校)\s*[。！？!?]*$/u, "")
      .trim() || question;
    onSearch?.();
    const hits = await searchPublicWeb(query.slice(0, 200), signal);
    if (hits.length) {
      return {
        evidence: JSON.stringify(hits.map(({ title, url, snippet }) => ({ title, url, snippet: snippet.slice(0, 500) }))),
        sources: "\n\n**本轮搜索来源**\n" + hits.map((hit, i) => "- [" + (i + 1) + ". " + hit.title.replace(/[\[\]\\\r\n]/g, " ") + "](<" + hit.url + ">)").join("\n"),
      };
    }
  } catch {
    signal?.throwIfAborted();
  }
  return { evidence: "本轮联网查询未取得可用资料。请明确说明当前事实未能核实，继续回答可独立分析的部分。", sources: "" };
}
