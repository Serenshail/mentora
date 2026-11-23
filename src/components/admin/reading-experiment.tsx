"use client";

/* v26.1 G5：阅读实验面板（/admin 第三个 tab）。
 * 数据源 = /api/admin/reading-metrics（管理员鉴权同款 x-admin-password，经 lib/admin-pw 内存暂存）。
 * 展示：核心漏斗（按用户去重）/ 迁移六分类 / 留存与第二问题 / 流失原因 / 单用户行为路径。 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Skeleton } from "@/components/ui";
import { pwHeaders } from "@/lib/admin-pw";
import { RefreshCw } from "lucide-react";

interface Metrics {
  ok: boolean;
  days: number;
  funnel: { name: string; users: number }[];
  transfer: { outcomes: Record<string, number>; submitUsers: number };
  retention: {
    d1: { retained: number; eligible: number };
    d7: { retained: number; eligible: number };
    revisit14: { retained: number; eligible: number };
    secondProblem: { started: number; eligible: number };
  };
  exitReasons: Record<string, number>;
  users: { account: string; d1: boolean | null; d7: boolean | null; secondProblem: boolean; timeline: { n: string; at: string }[] }[];
}

const FUNNEL_LABELS: Record<string, string> = {
  reading_started: "启动阅读",
  goal_confirmed: "确认目标",
  roadmap_generated: "生成路线",
  learning_node_started: "开始节点学习",
  node_assessment_completed: "完成节点验收",
  transfer_started: "启动迁移",
  transfer_submitted: "提交迁移",
  transfer_evaluated: "迁移判定",
  book_assessment_completed: "整本验收",
  graduation_generated: "结业总结",
  second_problem_started: "第二个问题",
};

const OUTCOME_LABELS: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "default" }> = {
  independent_success: { label: "独立迁移成功", tone: "ok" },
  assisted_success: { label: "辅助后成功", tone: "warn" },
  partial_success: { label: "部分完成", tone: "default" },
  incorrect: { label: "错误应用", tone: "bad" },
  incomplete: { label: "未完成", tone: "default" },
  ungradable: { label: "无法判定", tone: "default" },
};

export function ReadingExperiment() {
  const [data, setData] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openUser, setOpenUser] = useState<string | null>(null);
  /* 卸载中止句柄：面板切走后立刻掐掉挂起的响应 */
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    /* 本代码库客户端 fetch 的既有惯例：全部带硬超时（admin 面板家族 30s，
     * feedback-widget 15s）。指标接口要聚合多用户留存查询，取 30s——否则自托管端
     * 进程卡死/移动代理不 RST 时 loading 永不回落，面板只能整页刷新。
     * AbortSignal.any 不存在的旧浏览器退回纯超时，不因此失效。 */
    const timeout = AbortSignal.timeout(30_000);
    const signal = typeof AbortSignal.any === "function" ? AbortSignal.any([ac.signal, timeout]) : timeout;
    try {
      const res = await fetch("/api/admin/reading-metrics?days=30", { headers: pwHeaders(), signal });
      const json = (await res.json()) as Metrics & { error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || `${res.status}`);
      if (!ac.signal.aborted) setData(json);
    } catch (e) {
      if (ac.signal.aborted) return; // 卸载中止：不再写任何状态
      setError(e instanceof Error ? (e.name === "TimeoutError" ? "加载超时，请重试" : e.message) : "加载失败");
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 挪一拍：effect 同步 setState 是级联渲染红线（lint，login-form 先例）
    const t = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(t);
      abortRef.current?.abort();
    };
  }, [load]);

  if (loading && !data) return <Skeleton className="h-64 rounded-2xl bg-surface/60" />;
  if (error)
    return (
      <Card className="mt-6 border-bad/25 bg-bad/[0.04] p-4 text-sm text-bad">
        {error}
        <Button variant="outline" size="sm" className="ml-3" onClick={() => void load()}>
          重试
        </Button>
      </Card>
    );
  if (!data) return null;

  const peak = Math.max(1, ...data.funnel.map((f) => f.users));
  const outcomes = data.transfer.outcomes;
  const independent = outcomes.independent_success ?? 0;

  return (
    <div className="mt-6 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-ink">阅读实验 · 近 {data.days} 天</p>
        <Button variant="outline" size="sm" onClick={() => void load()} loading={loading}>
          <RefreshCw className="size-3.5" /> 刷新
        </Button>
      </div>

      {/* 核心漏斗 */}
      <Card className="p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-dim">核心漏斗（按用户去重）</p>
        <div className="mt-3 space-y-1.5">
          {data.funnel.map((f, i) => {
            const prev = i > 0 ? data.funnel[i - 1].users : f.users;
            const rate = prev > 0 ? Math.round((f.users / prev) * 100) : f.users > 0 ? 100 : 0;
            return (
              <div key={f.name} className="flex items-center gap-2">
                <span className="w-28 shrink-0 text-[11.5px] text-ink-dim">{FUNNEL_LABELS[f.name] ?? f.name}</span>
                <div className="h-4 min-w-0 flex-1 overflow-hidden rounded bg-black/[0.05]">
                  <div className="h-full rounded bg-accent/60" style={{ width: `${Math.max(2, (f.users / peak) * 100)}%` }} />
                </div>
                <span className="tabular w-14 text-right text-xs font-semibold text-ink">{f.users} 人</span>
                {i > 0 && <span className="tabular w-12 text-right text-[10.5px] text-ink-dim/70">{rate}%</span>}
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 知识迁移 */}
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-dim">知识迁移（提交迁移 {data.transfer.submitUsers} 人）</p>
          <div className="mt-3 space-y-2">
            {Object.entries(OUTCOME_LABELS).map(([k, meta]) => (
              <div key={k} className="flex items-center gap-2">
                <Badge tone={meta.tone}>{meta.label}</Badge>
                <span className="tabular ml-auto text-sm font-bold text-ink">{outcomes[k] ?? 0}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-ink-dim/70">
            独立成功只认「独立模式 + 换场景复检通过」——辅助模式通过计入辅助，不得混入（v26.1 G3）。
          </p>
        </Card>

        {/* 留存与复访 */}
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-dim">留存与复访</p>
          <div className="mt-3 space-y-2 text-[13px]">
            {([
              ["D1 复访", data.retention.d1],
              ["D7 复访", data.retention.d7],
              ["14 日复访", data.retention.revisit14],
            ] as [string, { retained: number; eligible: number }][]).map(([label, r]) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-ink-dim">{label}</span>
                <span className="tabular font-semibold text-ink">
                  {r.retained}/{r.eligible}
                  <span className="ml-1 text-[11px] text-ink-dim/70">人{r.eligible === 0 ? "（窗口未满）" : ""}</span>
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between border-t border-border pt-2">
              <span className="text-ink-dim">第二个真实问题</span>
              <span className="tabular font-semibold text-ok">
                {data.retention.secondProblem.started}/{data.retention.secondProblem.eligible} 人
              </span>
            </div>
          </div>
        </Card>
      </div>

      {/* 流失原因 */}
      {Object.keys(data.exitReasons).length > 0 && (
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-dim">流失原因（迁移放弃等轻条采集）</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {Object.entries(data.exitReasons)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, n]) => (
                <span key={reason} className="rounded-full border border-warn/30 bg-warn/[0.06] px-2.5 py-1 text-[11.5px] text-ink-dim">
                  {reason} · {n}
                </span>
              ))}
          </div>
        </Card>
      )}

      {/* 单用户行为路径 */}
      <Card className="p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-dim">用户行为路径（匿名，近 30 事件）</p>
        <div className="mt-2 divide-y divide-border">
          {data.users.map((u, idx) => (
            <div key={u.account}>
              <button
                onClick={() => setOpenUser(openUser === u.account ? null : u.account)}
                aria-expanded={openUser === u.account}
                aria-controls={`reading-timeline-${idx}`}
                className="flex w-full cursor-pointer items-center gap-2 py-2.5 text-left"
              >
                <span className="tabular font-mono text-[11px] text-ink-dim">{u.account.slice(0, 12)}…</span>
                {u.d7 === true && <Badge tone="ok">D7 复访</Badge>}
                {u.secondProblem && <Badge tone="accent">第二问题</Badge>}
                <span className="tabular ml-auto text-[11px] text-ink-dim/70">{u.timeline.length} 事件</span>
              </button>
              {openUser === u.account && (
                <div id={`reading-timeline-${idx}`} className="space-y-1 pb-3">
                  {u.timeline.map((e, i) => (
                    <p key={i} className="text-[11px] text-ink-dim">
                      <span className="tabular text-ink-dim/60">{e.at.slice(5, 16)}</span> · {FUNNEL_LABELS[e.n] ?? e.n}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
          {data.users.length === 0 && <p className="py-6 text-center text-sm text-ink-dim">还没有登录用户的阅读事件。</p>}
        </div>
      </Card>
    </div>
  );
}
