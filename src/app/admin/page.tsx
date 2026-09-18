"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Card } from "@/components/ui";
import { useAuth } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import {
  AlertCircle, CheckCircle2, CircleDot, ExternalLink, Inbox, Lock, MessageSquare, RefreshCw, Users,
} from "lucide-react";

interface AdminUser {
  userId: string;
  email: string;
  name: string;
  avatar?: string;
  createdAt: string;
  lastSyncAt: string | null;
  stats: { goals: number; knowledge: number; books: number; sessions: number; personas: number };
}

interface AdminFeedback {
  number: number;
  type: string;
  content: string;
  contact: string;
  state: string;
  createdAt: string;
  url: string;
}

interface Overview {
  you: { email: string; name: string };
  users: AdminUser[];
  feedback: AdminFeedback[];
  feedbackConfigured: boolean;
}

function fmtDate(iso: string | null): string {
  if (!iso || iso === "未知") return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export default function AdminPage() {
  const { user, checking, logout } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"users" | "feedback">("users");
  const [processingId, setProcessingId] = useState<number | null>(null);

  /* 一键处理/重开反馈（关/开 GitHub issue），改完本地同步状态 */
  const setFeedbackState = async (number: number, state: "open" | "closed") => {
    setProcessingId(number);
    try {
      const res = await fetch("/api/admin/feedback-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number, state }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "操作失败");
      setData((d) =>
        d
          ? { ...d, feedback: d.feedback.map((f) => (f.number === number ? { ...f, state } : f)) }
          : d
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setProcessingId(null);
    }
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/overview", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) {
        /* 会话失效（多标签页退出/凭证过期）:不留在报错页,直接送去重新登录 */
        if (res.status === 401) {
          setError("登录状态已过期，正在为你转到登录页…");
          setTimeout(() => {
            window.location.href = "/login?next=/admin";
          }, 800);
          return;
        }
        setError(j.error || "加载失败");
        setData(null);
      } else {
        setData(j as Overview);
      }
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!checking && user) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checking, user]);

  /* 未登录 / 鉴权中 */
  if (checking) {
    return <div className="flex min-h-screen items-center justify-center bg-bg text-sm text-ink-dim">加载中…</div>;
  }
  if (!user) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg px-6">
        <Lock className="size-8 text-ink-dim/50" strokeWidth={1.5} />
        <p className="text-sm font-bold text-ink">管理后台需要登录</p>
        <div className="flex flex-col items-center gap-2">
          <Button onClick={() => (window.location.href = "/login?next=/admin")}>去登录</Button>
          <a
            href="/api/debug/auth"
            target="_blank"
            className="text-xs text-ink-dim/60 hover:text-accent hover:underline"
          >
            查看登录状态调试信息 →
          </a>
        </div>
      </div>
    );
  }
  if (error === "此账号没有管理权限") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg px-6">
        <Lock className="size-8 text-ink-dim/50" strokeWidth={1.5} />
        <p className="text-sm font-bold text-ink">此账号没有管理权限</p>
        <p className="max-w-sm text-center text-xs leading-relaxed text-ink-dim">
          管理员邮箱在 Vercel 的 ADMIN_EMAILS 环境变量里配置（逗号分隔）。
          当前登录：{user.email}
        </p>
        <a
          href="/api/debug/auth"
          target="_blank"
          className="mt-2 text-xs text-ink-dim/60 hover:text-accent hover:underline"
        >
          查看登录状态调试信息 →
        </a>
      </div>
    );
  }

  const openCount = data?.feedback.filter((f) => f.state === "open").length ?? 0;
  const syncedCount = data?.users.filter((u) => u.lastSyncAt).length ?? 0;

  return (
    <div className="min-h-screen bg-bg">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        {/* 头部 */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold tracking-[-0.02em] text-ink">管理后台</h1>
              <Badge>内测</Badge>
              <Badge tone="accent">v5</Badge>
            </div>
            <p className="mt-1.5 text-[13px] text-ink-dim">
              {data?.you.email ?? user.email} · 用户数据与反馈总览，不用再去 GitHub 翻
            </p>
          </div>
          <Button variant="outline" onClick={load} loading={loading}>
            {!loading && <RefreshCw className="size-4" />} 刷新
          </Button>
        </div>

        {error && error !== "此账号没有管理权限" && (
          <Card className="mt-6 flex items-center gap-3 border-bad/25 bg-bad/[0.04]">
            <AlertCircle className="size-4 shrink-0 text-bad" />
            <p className="text-sm text-bad">{error}</p>
            {error.includes("重新登录") && (
              <Button
                variant="outline"
                className="ml-auto shrink-0"
                onClick={async () => {
                  await logout();
                  window.location.href = "/login?next=/admin";
                }}
              >
                重新登录
              </Button>
            )}
          </Card>
        )}

        {/* 统计卡 */}
        <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: "注册用户", value: data?.users.length ?? "—", icon: Users },
            { label: "有云端数据", value: data ? syncedCount : "—", icon: RefreshCw },
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
              { id: "users", label: `用户（${data?.users.length ?? 0}）` },
              { id: "feedback", label: `反馈（${data?.feedback.length ?? 0}）` },
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
        {tab === "users" && (
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
                            <div className="flex size-7 items-center justify-center rounded-lg bg-[#1a1a1a] text-[11px] font-bold text-white">
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
                      <td colSpan={5} className="px-4 py-12 text-center text-ink-dim">还没有注册用户</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="border-t border-border bg-black/[0.02] px-4 py-2.5 text-[11px] leading-relaxed text-ink-dim/70">
              密码说明：所有密码经 scrypt 单向哈希存储，连数据库原文都不存在——这是行业标准（Google/Apple 也一样），任何人、任何后台都无法查看用户密码原文。
            </p>
          </div>
        )}

        {/* 反馈列表 */}
        {tab === "feedback" && (
          <div className="mt-6 space-y-3">
            {data && !data.feedbackConfigured && (
              <Card className="border-warn/25 bg-warn/[0.04] text-xs text-warn">
                服务端未配置 GITHUB_TOKEN，反馈通道离线（用户提交会失败并本地排队）。
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
