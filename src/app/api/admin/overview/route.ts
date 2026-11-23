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

  let skippedUsers = 0; // 档案读取/解密失败 → 该用户从列表整体消失，必须让管理端知道
  let statsPartial = 0; // 云快照读取失败被折叠成全 0，与「从未上云」同形，排查丢数据时会误导
  let pagination: { page: number; totalPages: number; totalUsers: number } | undefined;

  try {
    let files = await dbList("users");
    /* 串行 N+1：每用户 2 次远端加密读（每次 decrypt 还要走一遍解密 + KV 往返），
     * N≈200 时保守估计就超 maxDuration=60 → 后台直接不可用。分块并发，
     * 块内并行、块间串行，既压满往返又不至于一次打爆远端。 */
    const CHUNK = 8;
    const requestedPage = req.nextUrl?.searchParams.get("page");
    if (requestedPage != null) {
      const totalUsers = files.length;
      const totalPages = Math.max(1, Math.ceil(totalUsers / CHUNK));
      const page = Math.min(totalPages, Math.max(1, Number.parseInt(requestedPage, 10) || 1));
      pagination = { page, totalPages, totalUsers };
      files = files.sort((a, b) => a.name.localeCompare(b.name)).slice((page - 1) * CHUNK, page * CHUNK);
    }
    for (let i = 0; i < files.length; i += CHUNK) {
      const part = await Promise.all(
        files.slice(i, i + CHUNK).map(async (f) => {
          try {
            const rec = await dbGet<UserRecord>(`users/${f.name}`, { encrypted: true });
            /* dbGet 成功但记录缺 userId（畸形/半写入档案）≠ 合法缺席：直接 return null
             * 会绕过 skippedUsers 计数，管理端出现「totalUsers - skippedUsers > 列表人数」
             * 且无从解释的差异。同 failed 口径计数，维持 files.length = 列表 + skipped 不变量 */
            if (!rec?.userId) return { user: null, failed: true, partial: false };
            let lastSyncAt: string | null = null;
            let stats = { goals: 0, knowledge: 0, books: 0, sessions: 0, personas: 0 };
            let partial = false;
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
            } catch {
              /* 读失败 ≠ 没有云端数据：dbGet 取不到的键走 null 不进这里 */
              partial = true;
            }
            return {
              user: {
                userId: rec.userId,
                email: rec.email,
                name: rec.name || "（未设置）",
                ...(rec.avatar ? { avatar: rec.avatar } : {}),
                createdAt: rec.createdAt ?? "未知",
                lastSyncAt,
                stats,
              },
              failed: false,
              partial,
            };
          } catch {
            return { user: null, failed: true, partial: false };
          }
        })
      );
      for (const r of part) {
        if (!r) continue;
        if (r.failed) skippedUsers++;
        if (r.partial) statsPartial++;
        if (r.user) users.push(r.user);
      }
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
  /* 拉取失败必须显式返回：旧实现一律静默折叠成空列表，坏 token 会让后台长期显示
   * 「0 条反馈」而运营完全无感。 */
  let feedbackError: string | null = null;
  /* 本片所有出站 fetch 都带 AbortSignal.timeout（linkcheck 6s / search 8s / mail 10s），这里是最后一处裸 fetch：
   * GitHub API 偶发挂起时整个 overview 被拖到 maxDuration=60 平台强杀 → 客户端 spinner 转满 60s
   * 后解析平台 500 HTML 失败，显示误导性的「网络错误」。10s 兜底与 mail.ts 同量级，超时走下方 catch
   * 进 feedbackError，overview 其余数据照常返回。 */
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
          signal: AbortSignal.timeout(10_000),
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
      else feedbackError = `GitHub 返回 ${res.status}`;
    } catch (e) {
      /* AbortSignal.timeout 触发时 Node 抛 DOMException 风格的 TimeoutError（instanceof Error 为 true，
       * 实测见 __tests__/admin-overview-feedback-timeout.test.ts），显式定性，别把
       * "The operation was aborted due to timeout" 原样顶给运营。 */
      feedbackError =
        (e as { name?: string }).name === "TimeoutError"
          ? "GitHub 反馈拉取超时（10s），请稍后重试"
          : e instanceof Error
            ? e.message
            : "反馈拉取失败";
    }
  }

  return Response.json({
    you,
    users,
    feedback,
    feedbackConfigured: Boolean(token),
    feedbackError,
    skippedUsers,
    statsPartial,
    pagination,
  });
}
