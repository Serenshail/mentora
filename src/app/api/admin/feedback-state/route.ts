import { NextRequest } from "next/server";
import { authorizeAdmin } from "@/lib/server/admin-auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

/** 管理员一键处理/重开反馈（对应 GitHub issue 的 close/reopen）。
 *  双鉴权:白名单会话 OR 后台密码头(外部后台管理系统走后者)。 */
export async function POST(req: NextRequest) {
  /* 与 overview/stats 同一把持久桶：这条路由接受后台密码，此前无专项限流。 */
  if (!(await rateLimitPersistent(`admin:feedback-state:${clientIp(req)}`, { capacity: 10, refillPerSec: 10 / 60 }))) {
    return Response.json({ error: "请求过于频繁" }, { status: 429 });
  }
  const admin = await authorizeAdmin(req);
  if (!admin) return Response.json({ error: "未授权" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const number = Number(body?.number);
  if (!Number.isInteger(number) || number < 1) {
    return Response.json({ error: "参数不对" }, { status: 400 });
  }
  /* state 是破坏性动作（关/开他人反馈）：只接受这两个字面量。
   * 此前任何非 "open" 值（"CLOSE"/"closed "/typo/缺失）都被静默归一为 "closed"，
   * 调用方想重开却传错值会把 issue 直接关掉且响应看不出异常 → 显式 400 拒绝。 */
  const rawState = body?.state;
  if (rawState !== "open" && rawState !== "closed") {
    return Response.json({ error: "参数不对：state 必须是 open 或 closed" }, { status: 400 });
  }
  const state: "open" | "closed" = rawState;

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || "haow9508-ctrl/mentora";
  if (!token) {
    return Response.json({ error: "服务端未配置 GITHUB_TOKEN" }, { status: 503 });
  }

  try {
    /* 全站远端调用统一 5s 硬超时（db.ts REMOTE_FETCH_TIMEOUT_MS 同值）：GitHub API
     * 网络黑洞时无兜底会挂到 undici headersTimeout 300s（Vercel maxDuration=30 有平台强杀，
     * 自托管长驻 Node 没有）→ 管理端长时间无响应且占连接槽。超时走下方 catch 显式定性。 */
    const res = await fetch(
      `https://api.github.com/repos/${repo}/issues/${number}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
          "User-Agent": "mentora-admin",
        },
        body: JSON.stringify({ state }),
        signal: AbortSignal.timeout(5_000),
      }
    );
    if (!res.ok) {
      return Response.json({ error: `处理失败（${res.status}）` }, { status: 502 });
    }
    return Response.json({ ok: true, state });
  } catch (e) {
    /* TimeoutError 显式定性，运营看到的是"超时可重试"而不是笼统"网络错误" */
    const isTimeout = (e as { name?: string }).name === "TimeoutError";
    return Response.json(
      { error: isTimeout ? "处理超时，请稍后重试" : "网络错误" },
      { status: isTimeout ? 504 : 502 }
    );
  }
}