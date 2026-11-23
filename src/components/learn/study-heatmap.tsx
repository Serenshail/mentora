"use client";

/* 学习日历（GitHub 提交墙的 Mentora 变体）：
 * - 格子语义：一格 = 当天有没有验收事件，强度 = 验收"质量"
 *   (0 无 → 1 只有新掌握、没做验收 → 2 有通过也有未过 → 3 当天验收全过)。
 *   我们的验收是双轨制，不数"提交次数"。
 * - 复习不单独造格子：FSRS 卡只存当前状态（st/due/last），回推不出"历史上每天复习了几条"，
 *   与其铺一层假数据，不如只画真实存在的验收事件（2026-10-27 删掉了曾经恒为 0 的复习字段）。
 * - 点击格子弹出当天验收详情，可回溯——正反馈=可看见的成长。
 * - 数据全部从现有 quizLog/knowledge 推导，零新存储。 */

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useAppStore } from "@/lib/store";
import { Card } from "@/components/ui";
import { addDays, cn, streakFrom, todayISO } from "@/lib/utils";

interface DayCell {
  date: string; // YYYY-MM-DD
  level: 0 | 1 | 2 | 3;
  quizPassed: number;
  quizTotal: number;
  mastered: number; // 当日新掌握知识点数
  future?: boolean; // 今天之后的空格子：不可点、不着色
}

/* 事件日期（quizLog.date / masteredAt）一律是 UTC 日字符串（utils.ts:70 不变量）：
 * 直接取前 10 位作 key。绝不能 new Date(q.date) 再读本地 getDate——UTC 零点被按本地
 * 时区分桶，负偏移用户当天学习会落到前一天甚至墙外。 */
function dayKey(raw: string): string | null {
  if (!raw) return null;
  const s = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function StudyHeatmap() {
  const goals = useAppStore((s) => s.goals);
  const knowledge = useAppStore((s) => s.knowledge);
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const [range, setRange] = useState<8 | 26>(8);
  /* 漫游 tabindex：整面墙只保留一个 Tab 站点（rovingTab），墙内用方向键移动。
   * 26×7 格若都留 tabIndex=0，键盘用户要按约 180 次 Tab 才能穿过热力图。 */
  const [rovingTab, setRovingTab] = useState<string | null>(null);
  const wallRef = useRef<HTMLDivElement>(null);
  const quizLog = useMemo(() => goals.flatMap((g) => g.quizLog ?? []), [goals]);

  const { weeks, streak, totalPass, today } = useMemo(() => {
    const byDate = new Map<string, DayCell>();
    /* 全程用 UTC 日字符串做 key（与 quizLog.date / masteredAt / todayISO 同一坐标系，
     * utils.ts:70 不变量）——事件日期绝不能再 new Date() 后读本地 getDate 分桶。 */
    const ensure = (k: string): DayCell => {
      if (!byDate.has(k)) byDate.set(k, { date: k, level: 0, quizPassed: 0, quizTotal: 0, mastered: 0 });
      return byDate.get(k)!;
    };

    for (const q of quizLog) {
      if (q.forced) continue; // 跳过不是一次能力验收。
      const k = dayKey(q.date);
      if (!k) continue;
      ensure(k).quizTotal++;
      if (q.passed) ensure(k).quizPassed++;
    }
    for (const k of knowledge ?? []) {
      if (/目录$|学习总纲要$/.test(k.title) || (k.tags ?? []).includes("MOC")) continue;
      const key = dayKey(k.masteredAt ?? "");
      if (!key) continue;
      ensure(key).mastered++;
    }
    // 复习事件不进格子：FSRS 卡只有当前状态，回推不出每天复习了几条（见文件头注释）。

    // 26 周 × 7 天的墙（纯 UTC 日历运算）：按今天所在周收尾对齐——周日开头、末列含今天。
    // 旧写法从今天回退 181 天再对齐到周日，墙尾会落在今天之前 0-6 天，
    // 最近几天（含今天）一周里只有周六能渲染，future 分支成死代码。
    const cells: DayCell[][] = [];
    const today = todayISO();
    const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay();
    const start = addDays(-(25 * 7 + todayDow), today);
    for (let w = 0; w < 26; w++) {
      const col: DayCell[] = [];
      for (let i = 0; i < 7; i++) {
        const key = addDays(w * 7 + i, start);
        if (key > today) {
          col.push({ date: key, level: 0, quizPassed: 0, quizTotal: 0, mastered: 0, future: true });
          continue;
        }
        const c = ensure(key);
        // level：3=当天验收全过 / 2=有通过也有未过 / 1=没做验收但当天新掌握了东西 / 0=无
        if (c.quizTotal > 0) c.level = c.quizPassed === c.quizTotal ? 3 : 2;
        else if (c.mastered > 0) c.level = 1;
        col.push(c);
      }
      cells.push(col);
    }

    // 连续天数：直接用 utils 的 streakFrom（今天没学不打断，从昨天起数）
    const activeDays = [...byDate.values()].filter((c) => c.quizTotal > 0 || c.mastered > 0).map((c) => c.date);
    const streak = streakFrom(activeDays);
    const totalPass = quizLog.filter((q) => q.passed && !q.forced).length;
    return { weeks: cells, streak, totalPass, today };
  }, [quizLog, knowledge]);
  const visibleWeeks = weeks.slice(-range);
  // 保存日期而非统计快照：同一天新增验收后，已展开的详情也要刷新。
  const picked = weeks.flat().find((c) => c.date === pickedDate) ?? null;

  const LVL = [
    "bg-black/[0.05]",
    "bg-accent/25",
    "bg-accent/55",
    "bg-accent",
  ];

  /* 墙内键盘导航：左/右 = 上一周/下一周（±7 天），上/下 = 前一天/后一天（±1 天）。
   * 目标格不存在或是 future（disabled）就原地不动，不跨墙循环。 */
  const cellDates = useMemo(() => new Set(weeks.flat().filter((c) => !c.future).map((c) => c.date)), [weeks]);
  /* 漫游焦点若指向已不在墙上的日期（跨零点重建墙等），回落到今天，保证整墙始终有一个 Tab 站点。 */
  const tabStop = rovingTab && cellDates.has(rovingTab) ? rovingTab : today;

  const onCellKeyDown = (e: KeyboardEvent<HTMLButtonElement>, date: string) => {
    const delta =
      e.key === "ArrowRight" ? 7 : e.key === "ArrowLeft" ? -7 : e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const target = addDays(delta, date);
    const next = wallRef.current?.querySelector<HTMLButtonElement>(`[data-date="${target}"]`);
    if (!next || next.disabled) return;
    setRovingTab(target);
    next.focus();
  };

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-ink">学习日历</p>
        <p className="text-xs text-ink-dim">
          验收通过 <b className="tabular text-ink">{totalPass}</b> 次 · 连续{" "}
          <b className="tabular text-ink">{streak}</b> 天
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs leading-relaxed text-ink-dim">点击日期查看验收与掌握记录 · 日期按 UTC 统计</p>
        <div className="flex rounded-lg bg-surface-2 p-1" aria-label="日历显示范围">
          {([8, 26] as const).map((value) => (
            <button key={value} type="button" aria-pressed={range === value}
              onClick={() => { setRange(value); setRovingTab(null); setPickedDate(null); }}
              className={cn("min-h-9 rounded-md px-3 text-xs", range === value ? "bg-surface font-semibold text-ink shadow-sm" : "text-ink-dim")}>
              近 {value} 周
            </button>
          ))}
        </div>
      </div>

      {/* 读屏摘要：格子墙本身是 26×7 个无名小方块，先给一句可读的整体概况，
       * 墙内则用方向键逐格探索（漫游 tabindex，整墙只占一个 Tab 站点）。 */}
      <p className="sr-only">
        最近 {range} 周学习日历，累计 {totalPass} 次验收通过、连续 {streak} 天。聚焦任一格后用方向键左右切换周、上下切换天，按 Enter 查看当天详情。
      </p>

      <div
        ref={wallRef}
        role="group"
        aria-label="学习日历格子"
        className="mt-4 overflow-x-auto pb-1"
        onKeyDown={(e) => {
          if (e.key === "Escape" && picked) setPickedDate(null);
        }}
      >
        <div className="flex w-max gap-1">
          {visibleWeeks.map((col, wi) => (
            <div key={wi} className="flex flex-col gap-1">
              {col.map((c) => {
                const future = c.future;
                /* 格子没有文本内容，title 对读屏命名不可靠：用 aria-label 给每格一个
                 * 明确的可访问名（含日期与验收/掌握结果），键盘/读屏不再面对无名按钮。 */
                const label = future
                  ? `${c.date} · 未到`
                  : `${c.date} · ${c.level === 0 ? "未学习" : `验收 ${c.quizPassed}/${c.quizTotal}${c.mastered ? ` · 掌握 ${c.mastered}` : ""}`}`;
                return (
                  <button
                    key={c.date}
                    disabled={future}
                    aria-label={label}
                    title={label}
                    data-date={c.date}
                    aria-pressed={pickedDate === c.date}
                    tabIndex={future ? -1 : tabStop === c.date ? 0 : -1}
                    onFocus={() => !future && setRovingTab(c.date)}
                    onKeyDown={(e) => onCellKeyDown(e, c.date)}
                    onClick={() => !future && setPickedDate(c.date)}
                    className={cn(
                      "size-7 shrink-0 cursor-pointer rounded-md transition hover:ring-2 hover:ring-accent/40 disabled:cursor-default",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
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
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-ink-dim">
        {LVL.map((l, i) => (
          <span key={i} className="inline-flex items-center gap-1.5"><span className={cn("size-2.5 rounded-sm", l)} />{["无记录", "新掌握", "验收待巩固", "验收全过"][i]}</span>
        ))}
      </div>

      {/* 当日详情：可回溯的正反馈。aria-live 容器常驻挂载（内容后插入），
       * 否则读屏可能不播报新建 live region 里的文本；关闭后把焦点还给原格子。 */}
      <div aria-live="polite" className={picked ? "mt-3" : ""}>
        {picked && (
          <div className="rounded-xl border border-border bg-surface-2/60 p-3 text-[12.5px] leading-relaxed text-ink-dim">
            <div className="flex items-center justify-between">
              <b className="text-ink">{picked.date}</b>
              <button
                onClick={() => {
                  const d = picked.date;
                  setPickedDate(null);
                  wallRef.current?.querySelector<HTMLButtonElement>(`[data-date="${d}"]`)?.focus();
                }}
                className="min-h-11 cursor-pointer px-3 text-ink-dim hover:text-ink"
              >
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
                : picked.level === 1
                  ? "这天有新掌握的知识点，尚无验收记录。"
                : picked.level === 3
                  ? "这一天验收全过——把它变成常规。"
                  : "有未通过的验收没关系，错过的会在复习里回来。"}
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
