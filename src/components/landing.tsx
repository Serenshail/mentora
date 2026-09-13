"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import {
  BookOpen, Brain, Compass, GraduationCap,
  ArrowRight, Check,
} from "lucide-react";

/* PopText 资产按需加载（css + js + emoji base） */
function usePopText(text: string, delay = 0) {
  const elRef = useRef<HTMLHeadingElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      // css
      if (!document.querySelector('link[data-poptext-css]')) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "/poptext/pop-text.css";
        link.setAttribute("data-poptext-css", "1");
        document.head.appendChild(link);
      }
      // 手写体
      if (!document.querySelector('link[data-popfont]')) {
        const font = document.createElement("link");
        font.rel = "stylesheet";
        font.href = "https://fonts.googleapis.com/css2?family=Great+Vibes&display=swap";
        font.setAttribute("data-popfont", "1");
        document.head.appendChild(font);
      }
      // js
      if (!(window as unknown as { PopText?: unknown }).PopText) {
        await new Promise<void>((resolve) => {
          const s = document.createElement("script");
          s.src = "/poptext/pop-text.js";
          s.onload = () => resolve();
          s.onerror = () => resolve();
          document.body.appendChild(s);
        });
      }
      const PT = (
        window as unknown as {
          PopText?: {
            setEmojiBase: (b: string) => void;
            type: (el: HTMLElement, t: string, o?: object) => Promise<void>;
            arm: (el: HTMLElement) => void;
          };
        }
      ).PopText;
      if (cancelled || !PT || !elRef.current) return;
      PT.setEmojiBase("/poptext/emoji/");
      PT.arm(elRef.current); // 悬停变形：必须在 type 前挂上（skill 文档：pointerover 委托）
      await PT.type(elRef.current, text, { step: 95, startDelay: delay, cursor: true });
      if (!cancelled) setReady(true);
    };
    void load();
    return () => { cancelled = true; };
  }, [text, delay]);

  return { elRef, ready };
}

const FEATURES = [
  {
    icon: GraduationCap,
    title: "学习教练",
    desc: "说出想学的东西，教练先摸清你的底细——目的、基础、习惯——再排计划。每天一课讲透，验收不过不放行。",
    points: ["总纲要 + 阶段计划两级推进", "六段教学：资料 / 穷尽 / 完整示范 / 拆解 / 变体 / 双验收", "学不会可以跳过，但会被记录"],
  },
  {
    icon: Brain,
    title: "第二大脑",
    desc: "学过的、想过的，全部变成互相连接的笔记。像 Obsidian 一样用 [[双链]] 织网，还有一张会生长的关系图谱。",
    points: ["验收通过的知识点自动入库", "1 / 3 / 7 / 15 天间隔复习", "AI 帮你找到笔记之间隐藏的联系"],
  },
  {
    icon: BookOpen,
    title: "读书伙伴",
    desc: "不替你总结，陪你把一本书读深。先解剖：这本书在反对谁、思想谱系是什么、争议在哪；再一章一章陪你聊。",
    points: ["按论证逻辑拆解，不照搬目录", "每章带其他思想家的交叉视角", "聊出来的洞见自动进第二大脑"],
  },
  {
    icon: Compass,
    title: "人生伙伴",
    desc: "焦虑、决策、自我怀疑——扔过来。Naval、乔布斯、芒格、张雪峰们会说真话：第一句就是判断，没有「取决于」。",
    points: ["12 位深度蒸馏的智者 + 全员圆桌", "主动给你观点的最强反方", "也可以锻造任何你想要的人"],
  },
];

const STEPS = [
  { n: "01", title: "说出你想学的", desc: "「我想学 Python」「我要考雅思」。教练问你几句，摸清目的、基础和习惯。" },
  { n: "02", title: "拿到你的计划", desc: "先给总纲要——学什么、什么顺序、边界在哪；每个阶段开始时，再按你的真实表现生成精准的每日计划。" },
  { n: "03", title: "每天推进，验收放行", desc: "每天一份讲义 + 一次验收。通过才解锁下一课，知识点自动沉淀、按遗忘曲线提醒你复习。" },
];

export default function Landing() {
  const { elRef, ready } = usePopText("Mentora", 300);

  return (
    <div className="min-h-screen">
      {/* 顶部导航 */}
      <header className="sticky top-0 z-40 border-b border-border bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <span className="font-brand text-[22px] leading-none text-ink">Mentora</span>
          <div className="flex items-center gap-2">
            <Link href="/login">
              <Button variant="ghost" size="sm">登录</Button>
            </Link>
            <Link href="/login?mode=register">
              <Button size="sm">免费开始</Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden px-4 pb-20 pt-24 text-center">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(700px 320px at 50% -8%, rgba(26,26,26,0.07), transparent 65%)",
          }}
        />
        <div className="relative">
          <h1
            ref={elRef}
            className="pop-text min-h-[1.5em] leading-none"
            style={{ fontFamily: "'Great Vibes', cursive", fontSize: "min(110px, 16vw)", color: "var(--color-ink)" }}
          />
          <p className="mx-auto mt-8 max-w-xl text-lg leading-relaxed text-ink-dim">
            一个把「学会任何东西」变成日常的系统：
            教练排计划、盯验收，笔记自己织成网，
            读书有人陪，困惑有人给你真话。
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link href="/login?mode=register">
              <Button size="lg">
                免费开始 <ArrowRight className="size-4" />
              </Button>
            </Link>
            <Link href="/login">
              <Button size="lg" variant="outline">我有账号</Button>
            </Link>
          </div>
          <p className="mt-4 text-xs text-ink-dim/70">
            注册即用 · 数据加密存储 · 随时可导出带走
          </p>
          {ready && (
            <p className="mt-10 text-xs text-ink-dim/60">
              ↑ 鼠标划过标题的每个字母试试
            </p>
          )}
        </div>
      </section>

      {/* 四大功能 */}
      <section className="mx-auto max-w-5xl px-4 py-16">
        <div className="grid gap-4 md:grid-cols-2">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-border bg-surface p-6 transition-shadow hover:shadow-[0_8px_32px_-12px_rgba(0,0,0,0.15)]"
            >
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-white text-accent">
                  <f.icon className="size-5" strokeWidth={1.75} />
                </div>
                <h3 className="text-base font-bold text-ink">{f.title}</h3>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-ink-dim">{f.desc}</p>
              <ul className="mt-4 space-y-1.5">
                {f.points.map((pt) => (
                  <li key={pt} className="flex items-start gap-2 text-[13px] text-ink-dim">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-ok" />
                    {pt}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* 三步 */}
      <section className="border-y border-border bg-surface/50 px-4 py-16">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-center text-xl font-bold tracking-[-0.02em] text-ink">三步，开始认真学一样东西</h2>
          <div className="mt-10 grid gap-8 md:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n}>
                <p className="tabular text-3xl font-extrabold text-accent/40">{s.n}</p>
                <h3 className="mt-2 text-base font-bold text-ink">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-dim">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 态度 */}
      <section className="mx-auto max-w-3xl px-4 py-20 text-center">
        <p className="text-lg leading-relaxed text-ink">
          它不负责哄你开心，负责让你变清醒。
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-dim">
          第一句话就是判断，没有「取决于」和「各有道理」。
          你错的时候它直说，你焦虑的时候它把情绪翻译成可以动手做的事。
        </p>
        <Link href="/login?mode=register" className="mt-8 inline-block">
          <Button size="lg">
            说出你想学的东西 <ArrowRight className="size-4" />
          </Button>
        </Link>
      </section>

      <footer className="border-t border-border px-4 py-8 text-center text-xs text-ink-dim/60">
        Mentora · 学习教练 × 第二大脑 × 读书伙伴 × 人生伙伴
      </footer>
    </div>
  );
}
