import { NextRequest } from "next/server";
import { dbFeedbackSave } from "@/lib/server/db";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/body-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * 用户反馈后端：直接写入 GitHub Issues。
 * 部署者在仓库 Issues 里即可看到全部反馈，可回复、可关单。
 * env: GITHUB_TOKEN（需 repo 权限）、GITHUB_REPO（默认 haow9508-ctrl/mentora）
 */
export async function POST(req: NextRequest) {
  // 防刷：每 IP 突发 5 条、每分钟回填 2 条（未登录也可反馈,故必须限流；持久桶跨实例一致，
  // 进程内桶在多实例下配额=每实例额度×实例数，可刷爆 GitHub Issues 配额）
  if (!(await rateLimitPersistent(`feedback:${clientIp(req)}`, { capacity: 5, refillPerSec: 2 / 60 }))) {
    return Response.json({ error: "反馈太频繁，请稍后再试" }, { status: 429 });
  }
  /* 体积闸（与 auth 全系、linkcheck 同一纪律）：本端点未登录即可调（限流 5 突发/2 每分回填），
   * req.json() 会把整个请求体缓冲并解析后才截断 content/contact——自托管（Caddy 默认不限
   * body）下限流额度内的 GB 级 JSON 就足以让 JSON.parse 的内存尖峰 OOM 杀掉单进程 Node
   * （body-limit.ts 头注释的威胁模型）。512KB 声明闸 + 流式终闸，超标回 413。 */
  const body = await readJsonBody(req);
  if (body === null) {
    return Response.json({ error: "反馈内容太大，请精简后重试" }, { status: 413 });
  }
  const content = String(body?.content ?? "").trim();
  /* body 来自 readJsonBody（Record<string, unknown>）：type 用逐值等值判定（与旧
   * includes(body?.type) 的同一性语义一致，数组等非字符串值不会误中）。 */
  const rawType: unknown = body?.type;
  const type = rawType === "建议" || rawType === "问题" || rawType === "其他" ? rawType : "其他";
  /* contact 是唯一没截断的用户输入：超长会把 GitHub Issue body 顶爆（API 直接 400 → 用户收到 502） */
  const contact = String(body?.contact ?? "").trim().slice(0, 200);
  const page = String(body?.page ?? "").slice(0, 120);

  if (content.length < 2) {
    return Response.json({ error: "反馈内容太短了" }, { status: 400 });
  }
  if (content.length > 4000) {
    return Response.json({ error: "反馈太长了，请精简到 4000 字以内" }, { status: 400 });
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || "haow9508-ctrl/mentora";
  if (!token) {
    return Response.json(
      { error: "反馈通道未配置（服务端缺少 GITHUB_TOKEN），反馈未送达" },
      { status: 503 }
    );
  }

  const ua = req.headers.get("user-agent")?.slice(0, 150) || "";
  const title = `[${type}] ${content.slice(0, 50)}${content.length > 50 ? "…" : ""}`;
  const meta = [
    "---",
    `来源页面：${page || "未知"}`,
    `时间：${new Date().toISOString()}`,
    contact ? `联系方式：${contact}` : "联系方式：未留",
    ua ? `环境：${ua}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "User-Agent": "mentora", // GitHub API 必需 UA，与 db.ts ghApi 同一取值
      },
      body: JSON.stringify({
        title,
        body: `${content}\n\n${meta}`,
        labels: ["user-feedback"],
      }),
      /* 全站远端调用统一 5s 硬超时（db.ts REMOTE_FETCH_TIMEOUT_MS、admin/feedback-state
       * 同值同注释）：GitHub API 网络黑洞时裸 fetch 会挂到 undici headersTimeout 默认 300s
       * （Vercel maxDuration=30 有平台强杀兜底，腾讯云自托管长驻 Node 没有），期间占住
       * 连接槽、用户侧长时间无响应；本端点是公开端点，故障期每个提交都挂满。 */
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return Response.json(
        { error: `反馈提交失败（${res.status}）` , detail: t.slice(0, 200) },
        { status: 502 }
      );
    }
    const issue = await res.json();
    /* 双写：D1 也存一份（冗余备份，失败不影响主流程） */
    await dbFeedbackSave({ number: issue.number, type, content, contact, page });
    return Response.json({ ok: true, url: issue.html_url, number: issue.number });
  } catch (e) {
    /* TimeoutError 显式定性（与 admin/feedback-state 同口径）：运营/用户看到的是
     * 「超时可重试」而不是笼统的「网络错误」。504 与 502 都不在客户端 fatal 判定
     * （feedback-widget 只认 400），会照常进 retry 队列。 */
    const isTimeout = (e as { name?: string }).name === "TimeoutError";
    if (isTimeout) {
      return Response.json({ error: "反馈提交超时，已转入稍后自动重试" }, { status: 504 });
    }
    return Response.json({ error: "网络错误，反馈未送达" }, { status: 502 });
  }
}
