import { NextRequest } from "next/server";
import { dbGet, dbList } from "@/lib/server/db";
import { authorizeAdmin } from "@/lib/server/admin-auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { logEvent } from "@/lib/server/config";

export const runtime = "nodejs";
export const maxDuration = 60;

/* 两条进入后台的路（v17：收口到 admin-auth.ts 单一实现，此前本文件复制过一份——漂移即事故隐患）：
   1) 管理员账号登录（白名单会话，且未被 sv 吊销）；
   2) 独立后台密码（x-admin-password 请求头，timing-safe 比对 ADMIN_PASSWORD）。
   后台密码通道此前 GET 无任何限流，可被慢慢爆破：现在每 IP 10/min 跨进程桶先挡一道。 */
async function authorize(req: NextRequest): Promise<{ email: string; name: string } | null> {
  return authorizeAdmin(req);
}

interface UserRecord {
  userId: string;
  email: string;
  name: string;
  createdAt?: string;
  avatar?: string;
}

interface DataRecord {
  updatedAt: string;
  data?: {
    goals?: unknown[];
    knowledge?: unknown[];
    books?: unknown[];
    sessions?: unknown[];
    customPersonas?: unknown[];
  };
}

export async function GET(req: NextRequest) {
  if (!(await rateLimitPersistent(`admin:${clientIp(req)}`, { capacity: 10, refillPerSec: 10 / 60 }))) {
    return Response.json({ error: "操作太频繁，请稍后再试" }, { status: 429 });
  }
  const you = await authorize(req);
  if (!you) {
    logEvent({ ev: "admin", msg: "denied", ip: clientIp(req) });
    return Response.json({ error: "未登录" }, { status: 401 });
  }
  logEvent({ ev: "admin", msg: "overview", by: you.email });

  /* ---- 用户列表 ---- */
  const users: {
    userId: string;
    email: string;
    name: string;
    avatar?: string;
    createdAt: string;
    lastSyncAt: string | null;
    stats: { goals: number; knowledge: number; books: number; sessions: number; personas: number };
  }[] = [];

  try {
    const files = await dbList("users");
    for (const f of files) {
      try {
        const rec = await dbGet<UserRecord>(`users/${f.name}`, { encrypted: true });
        if (!rec?.userId) continue;
        let lastSyncAt: string | null = null;
        let stats = { goals: 0, knowledge: 0, books: 0, sessions: 0, personas: 0 };
        try {
          const data = await dbGet<DataRecord>(`data/${rec.userId}.json`, { encrypted: true });
          if (data?.updatedAt) {
            lastSyncAt = data.updatedAt;
            stats = {
              goals: data.data?.goals?.length ?? 0,
              knowledge: data.data?.knowledge?.length ?? 0,
              books: data.data?.books?.length ?? 0,
              sessions: data.data?.sessions?.length ?? 0,
              personas: data.data?.customPersonas?.length ?? 0,
            };
          }
        } catch { /* 该用户没有云端数据 */ }
        users.push({
          userId: rec.userId,
          email: rec.email,
          name: rec.name || "（未设置）",
          ...(rec.avatar ? { avatar: rec.avatar } : {}),
          createdAt: rec.createdAt ?? "未知",
          lastSyncAt,
          stats,
        });
      } catch { /* 单个用户读失败不阻塞整个列表 */ }
    }
    users.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return Response.json({ error: "用户数据读取失败" }, { status: 503 });
  }

  /* ---- 反馈列表（GitHub Issues，label: user-feedback） ---- */
  const feedback: {
    number: number;
    type: string;
    content: string;
    contact: string;
    state: string;
    createdAt: string;
    url: string;
  }[] = [];

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || "haow9508-ctrl/mentora";
  if (token) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/issues?labels=user-feedback&state=all&per_page=100&sort=created&direction=desc`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "mentora-admin",
          },
          cache: "no-store",
        }
      );
      if (res.ok) {
        const issues = (await res.json()) as {
          number: number;
          title: string;
          body: string | null;
          state: string;
          created_at: string;
          html_url: string;
          pull_request?: unknown;
        }[];
        for (const it of issues) {
          if (it.pull_request) continue; // 过滤 PR
          const typeMatch = it.title.match(/^\[([^\]]+)\]/);
          feedback.push({
            number: it.number,
            type: typeMatch?.[1] ?? "其他",
            content: (it.body ?? "").split("\n\n---")[0] ?? "",
            contact: (it.body ?? "").match(/联系方式：(.+)/)?.[1]?.trim() || "",
            state: it.state,
            createdAt: it.created_at,
            url: it.html_url,
          });
        }
      }
    } catch { /* 反馈拉取失败不阻塞用户列表 */ }
  }

  return Response.json({
    you,
    users,
    feedback,
    feedbackConfigured: Boolean(token),
  });
}
