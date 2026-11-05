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
  const state = body?.state === "open" ? "open" : "closed";

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || "haow9508-ctrl/mentora";
  if (!token) {
    return Response.json({ error: "服务端未配置 GITHUB_TOKEN" }, { status: 503 });
  }

  try {
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
      }
    );
    if (!res.ok) {
      return Response.json({ error: `处理失败（${res.status}）` }, { status: 502 });
    }
    return Response.json({ ok: true, state });
  } catch {
    return Response.json({ error: "网络错误" }, { status: 502 });
  }
}