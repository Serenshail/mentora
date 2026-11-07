"use client";

/* ============================================================
 * V26.1 P1 新用户引导（PRD §8）：轻量弹窗，四模块各一句话。
 * 纪律：支持跳过 / 支持重新查看（设置里可触发）/ 已看过不重复弹出 /
 *       状态持久化（localStorage，按版本号——引导内容升级可重新弹出一次）。
 * ============================================================ */
import { useEffect, useState } from "react";
import { BookOpen, Compass, Footprints, GraduationCap, Sparkles } from "lucide-react";
import { Modal } from "@/components/ui";

const KEY = "mentora-onboarded-v1";
const STEPS = [
  {
    icon: Sparkles,
    title: "Mentora（首页对话框）",
    desc: "什么都可以直接说：提问、搜索、深讲代码、存笔记、建目标、改设置。写入操作会先给你确认。",
  },
  {
    icon: GraduationCap,
    title: "学习（教练 + 读书伙伴）",
    desc: "说想学什么，教练摸底后排计划；读书伙伴陪你逐章读、验收理解。",
  },
  {
    icon: Footprints,
    title: "学习人生（学习第三个 tab）",
    desc: "只记录学习成果与能力变化——里程碑时间线，不是操作日志。",
  },
  {
    icon: Compass,
    title: "人生伙伴",
    desc: "12 位角色 + 圆桌模式，帮你梳理纠结、给出多视角判断。",
  },
];

export function OnboardingModal() {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    /* 登录后（localStorage 有用户仓）才弹：匿名访客先让他们自己逛 */
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      try {
        const hasUser = Object.keys(localStorage).some((k) => k.startsWith("mentora-store-") && k !== "mentora-store-anon");
        const seen = localStorage.getItem(KEY) === "1";
        if (hasUser && !seen) setOpen(true);
      } catch { /* 隐私模式不弹 */ }
      setReady(true);
    }, 2500);
    return () => { done = true; clearTimeout(t); };
  }, []);

  const close = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch { /* 忽略 */ }
    setOpen(false);
  };

  if (!ready || !open) return null;
  return (
    <Modal
      open={open}
      onClose={close}
      title="欢迎使用 Mentora"
    >
      <div className="space-y-2.5">
        <p className="text-sm text-ink-dim">
          一个以你长期成长为中心的个人 AI 学习系统。四个部分，各管一件事：
        </p>
        {STEPS.map((st) => (
          <div key={st.title} className="flex items-start gap-2.5 rounded-xl border border-border bg-surface-2/40 p-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/[0.08] text-accent">
              <st.icon className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-bold text-ink">{st.title}</p>
              <p className="text-[12px] leading-relaxed text-ink-dim">{st.desc}</p>
            </div>
          </div>
        ))}
        <p className="text-[11px] text-ink-dim/70">
          这条引导只会出现一次。想再看，可以在对话里说"新手引导"。
        </p>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          onClick={close}
          className="cursor-pointer rounded-xl bg-[#1d1d1f] px-4 py-2 text-[13px] font-medium text-white transition hover:bg-black/80"
        >
          开始使用
        </button>
      </div>
    </Modal>
  );
}
