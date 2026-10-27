"use client";

/* 学习日历（GitHub 提交墙的 Mentora 变体）：
 * - 格子语义：一格 = 当天有没有验收事件，强度 = 验收"质量"
 *   (0 无 → 1 只有新掌握、没做验收 → 2 有通过也有未过 → 3 当天验收全过)。
 *   我们的验收是双轨制，不数"提交次数"。
 * - 复习不单独造格子：FSRS 卡只存当前状态（st/due/last），回推不出"历史上每天复习了几条"，
 *   与其铺一层假数据，不如只画真实存在的验收事件（2026-10-27 删掉了曾经恒为 0 的复习字段）。
 * - 点击格子弹出当天验收详情，可回溯——正反馈=可看见的成长。
 * - 数据全部从现有 quizLog/knowledge 推导，零新存储。 */

import { useMemo, useState } from "react";
import { useAppStore } from "@/lib/store";
import { Card } from "@/components/ui";
import { cn } from "@/lib/utils";

interface DayCell {
  date: string; // YYYY-MM-DD
  level: 0 | 1 | 2 | 3;
  quizPassed: number;
  quizTotal: number;
  mastered: number; // 当日新掌握知识点数
  future?: boolean; // 今天之后的空格子：不可点、不着色
}

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function StudyHeatmap() {
  const goals = useAppStore((s) => s.goals);
  const knowledge = useAppStore((s) => s.knowledge);
  const [picked, setPicked] = useState<DayCell | null>(null);
  const quizLog = useMemo(() => goals.flatMap((g) => g.quizLog ?? []), [goals]);

  const { weeks, streak, totalPass, today } = useMemo(() => {
    const byDate = new Map<string, DayCell>();
    const ensure = (d: Date): DayCell => {
      const k = localDateStr(d);
      if (!byDate.has(k)) byDate.set(k, { date: k, level: 0, quizPassed: 0, quizTotal: 0, mastered: 0 });
      return byDate.get(k)!;
    };

    for (const q of quizLog) {
      const d = new Date(q.date);
      if (isNaN(d.getTime())) continue;
      const c = ensure(d);
      c.quizTotal++;
      if (q.passed) c.quizPassed++;
    }
    for (const k of knowledge ?? []) {
      if (!k.masteredAt) continue;
      const d = new Date(k.masteredAt);
      if (isNaN(d.getTime())) continue;
      const c = ensure(d);
      c.mastered++;
    }
    // 复习事件不进格子：FSRS 卡只有当前状态，回推不出每天复习了几条（见文件头注释）。

    // 26 周 × 7 天的墙
    const cells: DayCell[][] = [];
    const today = new Date();
    const end = new Date(today);
    const start = new Date(today);
    start.setDate(start.getDate() - (26 * 7 - 1));
    // 按周对齐：从 start 所在周日起
    start.setDate(start.getDate() - start.getDay());
    for (let w = 0; w < 26; w++) {
      const col: DayCell[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + w * 7 + i);
        if (d > today) {
          col.push({ date: localDateStr(d), level: 0, quizPassed: 0, quizTotal: 0, mastered: 0, future: true });
          continue;
        }
        const c = ensure(d);
        // level：3=当天验收全过 / 2=有通过也有未过 / 1=没做验收但当天新掌握了东西 / 0=无
        if (c.quizTotal > 0) c.level = c.quizPassed === c.quizTotal ? 3 : 2;
        else if (c.mastered > 0) c.level = 1;
        col.push(c);
      }
      cells.push(col);
    }

    // 连续天数（到今天,允许昨天断但今天补上则仍连续——宽限 1 天由 UI 提示,这里按严格连续）
    let streak = 0;
    for (let i = 0; i < 365; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const c = byDate.get(localDateStr(d));
      const active = c && (c.quizTotal > 0 || c.mastered > 0);
      if (active) streak++;
      else if (i === 0) continue; // 今天还没学不扣
      else break;
    }
    const totalPass = quizLog.filter((q) => q.passed).length;
    return { weeks: cells, streak, totalPass, today: localDateStr(today) };
  }, [quizLog, knowledge]);

  const LVL = [
    "bg-black/[0.05]",
    "bg-accent/25",
    "bg-accent/55",
    "bg-accent",
  ];

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-ink">学习日历</p>
        <p className="text-xs text-ink-dim">
          验收通过 <b className="tabular text-ink">{totalPass}</b> 次 · 连续{" "}
          <b className="tabular text-ink">{streak}</b> 天
        </p>
      </div>

      <div className="mt-4 overflow-x-auto pb-1">
        <div className="flex gap-[3px]">
          {weeks.map((col, wi) => (
            <div key={wi} className="flex flex-col gap-[3px]">
              {col.map((c, di) => {
                const future = c.future;
                return (
                  <button
                    key={c.date}
                    title={future ? "" : `${c.date} · ${c.level === 0 ? "未学习" : `验收 ${c.quizPassed}/${c.quizTotal}${c.mastered ? ` · 掌握 ${c.mastered}` : ""}`}`}
                    onClick={() => !future && setPicked(c)}
                    className={cn(
                      "size-[11px] rounded-[3px] transition hover:ring-2 hover:ring-accent/40",
                      future ? "bg-transparent" : LVL[c.level],
                      c.date === today && "ring-1 ring-ink/40"
                    )}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-ink-dim/70">
        少
        {LVL.map((l, i) => (
          <span key={i} className={cn("size-[10px] rounded-[3px]", l)} />
        ))}
        多
      </div>

      {/* 当日详情：可回溯的正反馈 */}
      {picked && (
        <div className="mt-3 rounded-xl border border-border bg-surface-2/60 p-3 text-[12.5px] leading-relaxed text-ink-dim">
          <div className="flex items-center justify-between">
            <b className="text-ink">{picked.date}</b>
            <button onClick={() => setPicked(null)} className="cursor-pointer text-ink-dim hover:text-ink">
              关闭
            </button>
          </div>
          <p className="mt-1.5">
            验收：通过 {picked.quizPassed}/{picked.quizTotal}
            {picked.mastered > 0 && <> · 新掌握知识点 {picked.mastered} 个</>}
            {picked.level === 3 && picked.quizTotal > 0 && " 🎉 全部通过"}
          </p>
          <p className="mt-1 text-[11.5px] text-ink-dim/70">
            {picked.level === 0
              ? "这天没有学习记录。"
              : picked.level === 3
                ? "这一天验收全过——把它变成常规。"
                : "有未通过的验收没关系，错过的会在复习里回来。"}
          </p>
        </div>
      )}
    </Card>
  );
}
