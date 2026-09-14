import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/server/auth";

export const runtime = "nodejs";
export const maxDuration = 30;

function isAdmin(email: string): boolean {
  const list = (process.env.ADMIN_EMAILS || "text@qq.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}

/** 管理员一键处理/重开反馈（对应 GitHub issue 的 close/reopen） */
export async function POST(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(session.email)) {
    return Response.json({ error: "此账号没有管理权限" }, { status: 403 });
  }

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