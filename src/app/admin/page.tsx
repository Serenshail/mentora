"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Button, Card, Input } from "@/components/ui";
import { cn, formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { ArrowDownUp, MoreHorizontal, RefreshCcw, Search, Trash2 } from "lucide-react";

interface UserRow {
  email: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  goals: { topic?: string; direction?: string }[];
  knowledgeCount: number;
  booksCount: number;
  sessionsCount: number;
}

type SortKey = "updatedAt" | "knowledgeCount" | "goalsCount" | "createdAt";

function relTime(iso: string): string {
  if (iso === "从未同步") return "从未同步";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return formatDate(iso.slice(0, 10));
}

function statusOf(row: UserRow): { label: string; tone: string } {
  if (row.updatedAt === "从未同步") return { label: "未激活", tone: "text-ink-dim bg-white/5" };
  const days = (Date.now() - new Date(row.updatedAt).getTime()) / 86400000;
  if (days <= 7) return { label: "活跃", tone: "text-ok bg-ok/10" };
  if (days <= 30) return { label: "沉默", tone: "text-warn bg-warn/10" };
  return { label: "流失", tone: "text-bad bg-bad/10" };
}

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("updatedAt");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const deleteUser = async (email: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password || sessionStorage.getItem("mentora-admin-pwd"), email }),
      });
      const j = await res.json();
      if (!res.ok) {
        toast.error(j.error || "删除失败");
        return;
      }
      setRows((prev) => (prev ?? []).filter((x) => x.email !== email));
      toast.success(`已删除 ${email}（含云端数据）`);
    } catch {
      toast.error("删除失败");
    } finally {
      setBusy(false);
      setConfirmDelete(null);
      setMenuFor(null);
    }
  };

  const load = async (pwd?: string) => {
    const p = pwd ?? password;
    if (!p) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: p }),
      });
      const j = await res.json();
      if (!res.ok) {
        toast.error(j.error || "加载失败");
        if (res.status === 401) setRows(null);
        return;
      }
      setRows(j.rows);
      setPassword(p);
      sessionStorage.setItem("mentora-admin-pwd", p);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const saved = sessionStorage.getItem("mentora-admin-pwd");
    if (saved) {
      setPassword(saved);
      void load(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    let r = rows ?? [];
    const q = query.trim().toLowerCase();
    if (q) {
      r = r.filter(
        (x) =>
          x.email.toLowerCase().includes(q) ||
          x.name.toLowerCase().includes(q) ||
          x.goals.some((g) => (g.topic ?? "").toLowerCase().includes(q))
      );
    }
    return [...r].sort((a, b) => {
      switch (sortKey) {
        case "knowledgeCount": return b.knowledgeCount - a.knowledgeCount;
        case "goalsCount": return b.goals.length - a.goals.length;
        case "createdAt": return a.createdAt < b.createdAt ? 1 : -1;
        default: return a.updatedAt < b.updatedAt ? 1 : -1;
      }
    });
  }, [rows, query, sortKey]);

  const stats = useMemo(() => {
    const r = rows ?? [];
    const week = r.filter((x) => x.updatedAt !== "从未同步" && (Date.now() - new Date(x.updatedAt).getTime()) / 86400000 <= 7).length;
    return {
      total: r.length,
      weekActive: week,
      knowledge: r.reduce((a, x) => a + x.knowledgeCount, 0),
      goals: r.reduce((a, x) => a + x.goals.length, 0),
    };
  }, [rows]);

  if (!rows) {
    return (
      <div className="mx-auto max-w-sm pt-20">
        <Card className="p-6">
          <p className="text-sm font-bold text-ink">作者后台</p>
          <p className="mt-1 text-xs text-ink-dim">输入管理密码查看全部用户与数据。</p>
          <Input
            type="password"
            placeholder="管理密码"
            className="mt-4"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
          />
          <Button className="mt-3 w-full" onClick={() => load()} loading={busy}>
            进入控制台
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      {/* 顶栏 */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold tracking-[-0.02em] text-ink">用户控制台</h1>
          <p className="text-[11px] text-ink-dim">全部注册用户 · 云端数据概况</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load()} loading={busy}>
          <RefreshCcw className="size-3.5" /> 刷新
        </Button>
      </div>

      {/* 指标行 */}
      <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.06] lg:grid-cols-4">
        {([
          ["注册用户", stats.total],
          ["7 日活跃", stats.weekActive],
          ["学习目标", stats.goals],
          ["知识总量", stats.knowledge],
        ] as [string, number][]).map(([label, v]) => (
          <div key={label} className="bg-surface px-4 py-3.5">
            <p className="text-[11px] text-ink-dim">{label}</p>
            <p className="tabular mt-1 text-xl font-bold text-ink">{v}</p>
          </div>
        ))}
      </div>

      {/* 工具栏 */}
      <div className="mb-3 flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-dim" />
          <Input
            className="h-8 pl-8 text-xs"
            placeholder="搜邮箱 / 名字 / 学习主题…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span className="ml-auto text-[11px] text-ink-dim">{filtered.length} 条记录</span>
      </div>

      {/* 数据表 */}
      <div className="overflow-x-auto rounded-xl border border-white/[0.07]">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead>
            <tr className="border-b border-white/[0.07] bg-surface-2/40 text-[11px] uppercase tracking-wider text-ink-dim">
              <th className="px-4 py-2.5 font-medium">用户</th>
              <th className="px-3 py-2.5 font-medium">状态</th>
              <th className="cursor-pointer px-3 py-2.5 font-medium hover:text-ink" onClick={() => setSortKey("goalsCount")}>
                <span className="inline-flex items-center gap-1">目标 <ArrowDownUp className="size-3 opacity-50" /></span>
              </th>
              <th className="cursor-pointer px-3 py-2.5 font-medium hover:text-ink" onClick={() => setSortKey("knowledgeCount")}>
                <span className="inline-flex items-center gap-1">知识 <ArrowDownUp className="size-3 opacity-50" /></span>
              </th>
              <th className="px-3 py-2.5 font-medium">书 / 对话</th>
              <th className="cursor-pointer px-3 py-2.5 text-right font-medium hover:text-ink" onClick={() => setSortKey("updatedAt")}>
                <span className="inline-flex items-center gap-1">最近活跃 <ArrowDownUp className="size-3 opacity-50" /></span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const st = statusOf(r);
              const key = r.email;
              const open = expanded === key;
              return (
                <Fragment key={key}>
                  <tr
                    onClick={() => setExpanded(open ? null : key)}
                    className={cn(
                      "cursor-pointer border-b border-white/[0.05] transition-colors",
                      open ? "bg-accent/[0.06]" : "hover:bg-white/[0.03]"
                    )}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink">{r.name}</p>
                      <p className="text-[11px] text-ink-dim">{r.email}</p>
                    </td>
                    <td className="px-3 py-3">
                      <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", st.tone)}>
                        <span className="size-1.5 rounded-full bg-current" />
                        {st.label}
                      </span>
                    </td>
                    <td className="tabular px-3 py-3">{r.goals.length}</td>
                    <td className="tabular px-3 py-3">{r.knowledgeCount}</td>
                    <td className="tabular px-3 py-3 text-ink-dim">
                      {r.booksCount} / {r.sessionsCount}
                    </td>
                    <td className="relative px-3 py-3 text-right">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuFor(menuFor === key ? null : key);
                        }}
                        className="rounded-lg p-1.5 text-ink-dim transition hover:bg-black/[0.05] hover:text-ink cursor-pointer"
                      >
                        <MoreHorizontal className="size-4" />
                      </button>
                      {menuFor === key && (
                        <div
                          className="absolute right-3 top-9 z-20 w-40 overflow-hidden rounded-xl border border-border bg-white shadow-lg"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => {
                              setExpanded(open ? null : key);
                              setMenuFor(null);
                            }}
                            className="w-full px-3.5 py-2.5 text-left text-xs text-ink hover:bg-black/[0.04] cursor-pointer"
                          >
                            展开详情
                          </button>
                          <button
                            onClick={() => {
                              navigator.clipboard?.writeText(r.email);
                              setMenuFor(null);
                              toast.success("邮箱已复制");
                            }}
                            className="w-full px-3.5 py-2.5 text-left text-xs text-ink hover:bg-black/[0.04] cursor-pointer"
                          >
                            复制邮箱
                          </button>
                          <button
                            onClick={() => {
                              setConfirmDelete(r.email);
                              setMenuFor(null);
                            }}
                            className="w-full px-3.5 py-2.5 text-left text-xs text-bad hover:bg-bad/[0.06] cursor-pointer"
                          >
                            删除用户…
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                  {open && (
                    <tr className="border-b border-white/[0.05] bg-black/20">
                      <td colSpan={6} className="px-4 py-3">
                        <div className="grid gap-4 md:grid-cols-2">
                          <div>
                            <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-dim">学习目标</p>
                            {r.goals.length === 0 ? (
                              <p className="text-xs text-ink-dim/60">—</p>
                            ) : (
                              r.goals.map((g, j) => (
                                <p key={j} className="truncate text-xs text-ink-dim">
                                  · <b className="text-ink">{g.topic}</b> — {g.direction}
                                </p>
                              ))
                            )}
                          </div>
                          <div className="text-xs text-ink-dim">
                            <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider">账号</p>
                            <p>注册：{r.createdAt === "?" ? "?" : new Date(r.createdAt).toLocaleString("zh-CN")}</p>
                            <p className="mt-1">最近同步：{r.updatedAt === "从未同步" ? "从未" : new Date(r.updatedAt).toLocaleString("zh-CN")}</p>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-ink-dim">
                  没有匹配的用户
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] text-ink-dim/60">
        点击行展开详情 · 点列头排序 · 数据来自加密数据库，明文仅此页可见
      </p>

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmDelete(null)}>
          <Card className="max-w-sm" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-bold text-ink">删除 {confirmDelete}？</p>
            <p className="mt-2 text-xs leading-relaxed text-ink-dim">
              其账号与云端全部数据（学习目标、笔记、对话）将被永久移除，不可恢复。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>取消</Button>
              <Button variant="danger" size="sm" onClick={() => deleteUser(confirmDelete)} loading={busy}>
                确认删除
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
