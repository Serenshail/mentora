"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, Input, Skeleton } from "@/components/ui";
import { useAuth } from "@/lib/auth-client";
import { adminOverviewSchema, type AdminOverview } from "@/lib/admin-overview-schema";
import { pwHeaders, rememberPw, forgetPw } from "@/lib/admin-pw";
import { ReadingExperiment } from "@/components/admin/reading-experiment";
import { cn } from "@/lib/utils";
import {
  AlertCircle, CheckCircle2, CircleDot, ExternalLink, Inbox, Lock, MessageSquare, RefreshCw, Users,
} from "lucide-react";

function fmtDate(iso: string | null): string {
  if (!iso || iso === "未知") return "—";
  // 非法时间串 new Date 不抛异常、只会得 NaN：先判，别让中文后台渲染出 "Invalid Date"
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

/* 后台密码只存内存（lib/admin-pw）：刷新/一键处理的请求统一带头，
 * 密码进入的非 admin 会话在本页生命周期内不再反复 401 退回密码门。
 * 不落 sessionStorage——它对同源任意脚本可读，明文主密码被 XSS 读走可在
 * 任意设备永久重放；刷新重输一次是有意付出的成本。 */

export default function AdminPage() {
  const { user, checking } = useAuth();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"users" | "feedback" | "reading">("users");
  const [processingId, setProcessingId] = useState<number | null>(null);
  /* 一键处理失败要在反馈卡片就地可见：列表在长页底部，只落顶部错误卡时
   * 视口内只有按钮文字弹回、状态徽标未变，容易被读成操作成功 */
  const [feedbackErr, setFeedbackErr] = useState<{ number: number; message: string } | null>(null);
  /* 独立后台密码：不需要登录账号，输对密码直接看数据（也绕开一切登录跳转问题） */
  const [needPw, setNeedPw] = useState(false);
  const [pw, setPw] = useState("");

  /* 一键处理/重开反馈（关/开 GitHub issue），改完本地同步状态 */
  const setFeedbackState = async (number: number, state: "open" | "closed") => {
    setProcessingId(number);
    setFeedbackErr(null);
    try {
      const res = await fetch("/api/admin/feedback-state", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...pwHeaders() },
        body: JSON.stringify({ number, state }),
        // 30s 硬超时同 load()：连接悬置时按钮不能永久停在 disabled「处理中…」
        signal: AbortSignal.timeout(30_000),
      });
      // 网关 502 返回 HTML 时 res.json() 抛 SyntaxError，原始 message 不可读——与 login-form 同款防御
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "操作失败");
      setData((d) =>
        d
          ? { ...d, feedback: d.feedback.map((f) => (f.number === number ? { ...f, state } : f)) }
          : d
      );
    } catch (e) {
      const msg =
        e instanceof Error && e.name === "TimeoutError"
          ? "操作超时，请重试"
          : e instanceof Error
            ? e.message
            : "操作失败";
      setError(msg);
      setFeedbackErr({ number, message: msg });
    } finally {
      setProcessingId(null);
    }
  };

  /* 会话管理员免密进入；否则落到底部密码门。401 一律不跳转，就地出密码框 */
  const load = async (password?: string, page = 1) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/overview?page=${page}`, {
        cache: "no-store",
        headers: { ...pwHeaders(), ...(password ? { "x-admin-password": password } : {}) },
        signal: AbortSignal.timeout(30_000),
      });
      const j = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          forgetPw(); // 存下的密码已失效/不对：清掉，别下次刷新又拿它撞 401
          setNeedPw(true);
          setData(null);
          setError(password ? "后台密码不对，再试一次" : null);
        } else {
          setError(j.error || "加载失败");
        }
      } else {
        /* 双端部署前后端版本可能不同步：成功 2xx 的形状也不设防的话，
         * users/feedback 缺失/改名会在渲染处 TypeError（本路由无 error.tsx，整页白屏）。
         * parse 失败就地降级为「加载失败」，页面可刷新重试，绝不炸掉。 */
        const parsed = adminOverviewSchema.safeParse(j);
        if (!parsed.success) {
          setError("数据格式异常，请稍后重试");
          setData(null);
        } else {
          if (password) rememberPw(password);
          setNeedPw(false);
          setData(parsed.data);
        }
      }
    } catch (error) {
      setError(error instanceof Error && error.name === "TimeoutError" ? "读取超时，请重试" : "网络错误，请重试");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (checking) return;
    // v17：load 同步 setState（loading）挪出 effect 体一拍，避免级联渲染告警
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [checking]);

  const submitPw = async () => {
    if (loading || !pw) return;
    await load(pw);
  };

  /* 鉴权中 */
  if (checking) {
    return <div className="flex min-h-screen items-center justify-center bg-bg text-sm text-ink-dim">加载中…</div>;
  }

  /* 后台密码门：会话不是管理员/已失效时，输对密码即可进入 */
  if (needPw) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center gap-4 bg-bg px-6">
        <Link
          href="/"
          className="absolute left-4 top-4 text-xs text-ink-dim/60 transition hover:text-ink sm:left-6 sm:top-6"
        >
          ← 返回首页
        </Link>
        <Lock className="size-8 text-ink-dim/50" strokeWidth={1.5} />
        <p className="text-sm font-bold text-ink">管理后台</p>
        <p className="text-xs text-ink-dim">输入后台密码查看全部用户数据</p>
        <div className="flex w-full max-w-xs gap-2">
          <Input
            type="password"
            placeholder="后台密码"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitPw()}
            autoFocus
          />
          <Button onClick={submitPw} loading={loading}>
            进入
          </Button>
        </div>
        {error && <p className="text-xs text-bad">{error}</p>}
        <a
          href="/api/debug/auth"
          target="_blank"
          className="text-xs text-ink-dim/60 hover:text-accent hover:underline"
        >
          查看登录状态调试信息 →
        </a>
      </div>
    );
  }

  const openCount = data?.feedback.filter((f) => f.state === "open").length ?? 0;
  const syncedCount = data?.users.filter((u) => u.lastSyncAt).length ?? 0;
  const pagination = data?.pagination;
  const totalUsers = pagination?.totalUsers ?? data?.users.length;

  return (
    <div className="min-h-screen bg-bg">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        {/* 未登录（密码进入）时也有返回应用的出口，不困在后台里 */}
        {!user && (
          <Link href="/" className="text-xs text-ink-dim/60 transition hover:text-ink">
            ← 返回首页
          </Link>
        )}
        {/* 头部 */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold tracking-[-0.02em] text-ink">管理后台</h1>
              <Badge>内测</Badge>
              <Badge tone="accent">v5</Badge>
            </div>
            <p className="mt-1.5 text-[13px] text-ink-dim">
              {data?.you.email ?? user?.email ?? "管理后台"} · 用户数据与反馈总览，不用再去 GitHub 翻
            </p>
          </div>
          <Button variant="outline" onClick={() => load(undefined, pagination?.page)} loading={loading}>
            {!loading && <RefreshCw className="size-4" />} 刷新
          </Button>
        </div>

        {error && (
          <Card className="mt-6 flex items-center gap-3 border-bad/25 bg-bad/[0.04]">
            <AlertCircle className="size-4 shrink-0 text-bad" />
            <p className="text-sm text-bad">{error}</p>
          </Card>
        )}

        {/* 统计卡 */}
        <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: "注册用户", value: totalUsers ?? "—", icon: Users },
            { label: pagination ? "本页有云端数据" : "有云端数据", value: data ? syncedCount : "—", icon: RefreshCw },
            { label: "反馈总数", value: data?.feedback.length ?? "—", icon: MessageSquare },
            { label: "待处理反馈", value: data ? openCount : "—", icon: Inbox },
          ].map((s) => (
            <Card key={s.label} className="p-4">
              <div className="flex items-center gap-2 text-ink-dim">
                <s.icon className="size-3.5" />
                <span className="text-xs">{s.label}</span>
              </div>
              <p className="tabular mt-2 text-2xl font-bold tracking-tight text-ink">{s.value}</p>
            </Card>
          ))}
        </div>

        {/* 标签切换 */}
        <div className="mt-8 flex gap-1 border-b border-border">
          {(
            [
              { id: "users", label: `用户（${totalUsers ?? 0}）` },
              { id: "feedback", label: `反馈（${data?.feedback.length ?? 0}）` },
              { id: "reading", label: "阅读实验" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "-mb-px cursor-pointer border-b-2 px-4 py-2.5 text-[13.5px] font-medium transition",
                tab === t.id
                  ? "border-ink text-ink"
                  : "border-transparent text-ink-dim hover:text-ink"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* 用户表 */}
        {tab === "users" && !data && loading && (
          <div className="mt-6 space-y-3">
            {/* 加载中必须是骨架而不是空表：空表会被读成「还没有注册用户」 */}
            <Skeleton className="h-16 rounded-2xl" />
            <Skeleton className="h-16 rounded-2xl" />
            <Skeleton className="h-16 rounded-2xl" />
          </div>
        )}
        {tab === "users" && data && ((data.skippedUsers ?? 0) > 0 || (data.statsPartial ?? 0) > 0) && (
          <Card className="mt-6 border-warn/25 bg-warn/[0.04] text-xs leading-relaxed text-warn">
            {(data.skippedUsers ?? 0) > 0 && (
              <p>{data.skippedUsers} 个用户档案读取失败，未出现在下面的列表里（不是「不存在」）。</p>
            )}
            {(data.statsPartial ?? 0) > 0 && (
              <p>{data.statsPartial} 个用户的云端数据读取失败，其数据量显示为 0（不等于未上云）。</p>
            )}
          </Card>
        )}
        {tab === "users" && data && (
          <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-surface">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-black/[0.02] text-xs text-ink-dim">
                    <th className="px-4 py-3 font-medium">用户</th>
                    <th className="px-4 py-3 font-medium">邮箱</th>
                    <th className="px-4 py-3 font-medium">注册时间</th>
                    <th className="px-4 py-3 font-medium">最近同步</th>
                    <th className="px-4 py-3 font-medium">数据量（目标/笔记/书/对话/人物）</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.users.map((u) => (
                    <tr key={u.userId} className="border-b border-border/60 last:border-0 hover:bg-black/[0.015]">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          {u.avatar ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={u.avatar} alt={u.name} className="size-7 rounded-lg border border-border object-cover" />
                          ) : (
                            <div className="flex size-7 items-center justify-center rounded-lg bg-ink text-[11px] font-bold text-white">
                              {u.name.slice(0, 1).toUpperCase()}
                            </div>
                          )}
                          <span className="font-medium text-ink">{u.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-ink-dim">{u.email}</td>
                      <td className="px-4 py-3 text-ink-dim">{fmtDate(u.createdAt)}</td>
                      <td className="px-4 py-3 text-ink-dim">{u.lastSyncAt ? fmtDate(u.lastSyncAt) : "—"}</td>
                      <td className="px-4 py-3">
                        <span className="tabular text-ink-dim">
                          {u.stats.goals} / {u.stats.knowledge} / {u.stats.books} / {u.stats.sessions} / {u.stats.personas}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {data && data.users.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-12 text-center text-ink-dim">{totalUsers ? "本页没有可显示的用户" : "还没有注册用户"}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {pagination && pagination.totalPages > 1 && (
              <nav aria-label="用户列表分页" className="flex items-center justify-end gap-3 border-t border-border px-4 py-3 text-xs">
                <Button variant="outline" size="sm" disabled={loading || pagination.page <= 1} onClick={() => void load(undefined, pagination.page - 1)}>上一页</Button>
                <span className="text-ink-dim">{pagination.page} / {pagination.totalPages}</span>
                <Button variant="outline" size="sm" disabled={loading || pagination.page >= pagination.totalPages} onClick={() => void load(undefined, pagination.page + 1)}>下一页</Button>
              </nav>
            )}
            <p className="border-t border-border bg-black/[0.02] px-4 py-2.5 text-[11px] leading-relaxed text-ink-dim/70">
              密码说明：所有密码经 scrypt 单向哈希存储，连数据库原文都不存在——这是行业标准（Google/Apple 也一样），任何人、任何后台都无法查看用户密码原文。
            </p>
          </div>
        )}

        {/* 反馈列表 */}
        {tab === "reading" && <ReadingExperiment />}
        {tab === "feedback" && !data && (
          <div className="mt-6 space-y-3">
            {/* 与用户表同规范：加载中必须是骨架而不是空白，「没有反馈」要有明确文案兜底 */}
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-24 rounded-2xl" />
          </div>
        )}
        {tab === "feedback" && data && (
          <div className="mt-6 space-y-3">
            {!data.feedbackConfigured && (
              <Card className="border-warn/25 bg-warn/[0.04] text-xs text-warn">
                服务端未配置 GITHUB_TOKEN，反馈通道离线（用户提交会失败并本地排队）。
              </Card>
            )}
            {data?.feedbackError && (
              <Card className="border-bad/25 bg-bad/[0.04] text-xs text-bad">
                反馈列表拉取失败：{data.feedbackError}。下面的「{data.feedback.length} 条」不是真实总数，
                排查前别把它当成「没有新反馈」。
              </Card>
            )}
            {data?.feedback.map((f) => (
              <Card key={f.number} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={f.type === "问题" ? "bad" : f.type === "建议" ? "accent" : undefined}>
                    {f.type}
                  </Badge>
                  <span className="text-xs text-ink-dim">#{f.number} · {fmtDate(f.createdAt)}</span>
                  {f.state === "open" ? (
                    <span className="flex items-center gap-1 text-xs text-accent">
                      <CircleDot className="size-3" /> 待处理
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-ink-dim/60">
                      <CheckCircle2 className="size-3" /> 已处理
                    </span>
                  )}
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto inline-flex items-center gap-1 text-xs text-ink-dim transition hover:text-accent"
                  >
                    GitHub <ExternalLink className="size-3" />
                  </a>
                  <button
                    onClick={() => setFeedbackState(f.number, f.state === "open" ? "closed" : "open")}
                    disabled={processingId === f.number}
                    className={cn(
                      "cursor-pointer rounded-lg border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50",
                      f.state === "open"
                        ? "border-ok/30 bg-ok/[0.06] text-ok hover:bg-ok/[0.12]"
                        : "border-border bg-white text-ink-dim hover:text-ink"
                    )}
                  >
                    {processingId === f.number
                      ? "处理中…"
                      : f.state === "open"
                        ? "标记已处理"
                        : "重新打开"}
                  </button>
                </div>
                {feedbackErr?.number === f.number && (
                  <p className="mt-2 text-xs text-bad">操作失败：{feedbackErr.message}（上方状态徽标未变，即未生效）</p>
                )}
                <p className="mt-2.5 whitespace-pre-wrap text-sm leading-relaxed text-ink">{f.content}</p>
                {f.contact && (
                  <p className="mt-2 text-xs text-ink-dim">联系方式：{f.contact}</p>
                )}
              </Card>
            ))}
            {data && data.feedback.length === 0 && (
              <Card className="p-12 text-center text-sm text-ink-dim">还没有收到反馈</Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
