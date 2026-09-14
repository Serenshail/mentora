"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTypewriter } from "@/lib/use-typewriter";
import { ArrowRight, BookOpen, Brain, Check, Compass, GraduationCap } from "lucide-react";

/* ================= Mainframe 规格资产 ================= */

const VIDEO_SRC = "/hero.mp4";
const SENSITIVITY = 0.8; // 鼠标横向移动 → 视频时间轴的灵敏度
const CONTACT_EMAIL = "hi@mentora.app";

/** 鼠标横向擦洗控制的背景视频（不自动播放，onSeeked 排队防 seek 洪泛） */
function HeroVideo() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let prevX: number | null = null;
    let target = 0;
    let seeking = false;

    /* 初始帧：0 帧多为暗场，偏移到 12% 处的角色画面，第一眼就有内容 */
    const onLoaded = () => {
      if (video.duration && isFinite(video.duration)) {
        target = video.duration * 0.12;
        video.currentTime = target;
        seeking = true;
      }
    };
    const applySeek = () => {
      if (seeking || !video.duration) return;
      seeking = true;
      video.currentTime = target;
    };
    const onSeeked = () => {
      seeking = false;
      if (Math.abs(video.currentTime - target) > 0.05) applySeek();
    };
    const onMove = (e: MouseEvent) => {
      if (prevX !== null && video.duration) {
        const delta = e.clientX - prevX;
        target = Math.min(
          Math.max(target + (delta / window.innerWidth) * SENSITIVITY * video.duration, 0),
          video.duration
        );
        applySeek();
      }
      prevX = e.clientX;
    };

    if (video.readyState >= 1) onLoaded();
    video.addEventListener("loadeddata", onLoaded);
    window.addEventListener("mousemove", onMove);
    video.addEventListener("seeked", onSeeked);
    return () => {
      video.removeEventListener("loadeddata", onLoaded);
      window.removeEventListener("mousemove", onMove);
      video.removeEventListener("seeked", onSeeked);
    };
  }, []);

  return (
    <>
      {/* 兜底层：视频加载失败（VPN/断网/代理拦截）时保证深色底成立，白字永远可读 */}
      <div className="fixed inset-0 z-0 bg-ink" />
      <video
        ref={ref}
        src={VIDEO_SRC}
        poster="/hero-poster.jpg"
        muted
        playsInline
        preload="auto"
        onError={(e) => e.currentTarget.remove()} /* 加载失败就移除，露出兜底层 */
        className="fixed inset-0 z-0 h-full w-full object-cover"
        style={{ objectPosition: "70% center", filter: "brightness(1.06) contrast(1.04)" }}
      />
      {/* 可读性压暗层：减到 15%，保白字成立的同时不灰 */}
      <div className="pointer-events-none fixed inset-0 z-0 bg-black/15" />
    </>
  );
}

/** 药丸按钮（白底 / 描边两态，规格样式） */
function Pill({
  href,
  onClick,
  outline,
  children,
}: {
  href?: string;
  onClick?: () => void;
  outline?: boolean;
  children: React.ReactNode;
}) {
  const cls = outline
    ? "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full border border-white bg-transparent px-4 text-white transition-colors duration-200 hover:bg-white hover:text-black sm:gap-3 sm:px-5"
    : "inline-flex items-center justify-center whitespace-nowrap rounded-full border border-black/10 bg-white px-4 text-black transition-colors duration-200 hover:bg-black hover:text-white sm:px-5";
  const size = "py-[0.3em] mx-[0.2em] mb-[0.4em] text-[13px] sm:text-[15px]";
  if (href) {
    return (
      <a href={href} onClick={onClick} className={`${cls} ${size}`}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={`${cls} ${size} cursor-pointer`}>
      {children}
    </button>
  );
}

/* ================= 内容 ================= */

const FEATURES = [
  {
    id: "coach",
    icon: GraduationCap,
    title: "学习教练",
    desc: "说出想学的东西，教练先摸清你的底细——目的、基础、习惯——再排计划。每天一课讲透，验收不过不放行。",
    points: ["总纲要 + 阶段计划两级推进", "六段教学：资料 / 穷尽 / 完整示范 / 拆解 / 变体 / 双验收", "学不会可以跳过，但会被记录"],
  },
  {
    id: "brain",
    icon: Brain,
    title: "第二大脑",
    desc: "学过的、想过的，全部变成互相连接的笔记。像 Obsidian 一样用 [[双链]] 织网，还有一张会生长的关系图谱。",
    points: ["验收通过的知识点自动入库", "1 / 3 / 7 / 15 天间隔复习", "自动帮你找到笔记之间隐藏的联系"],
  },
  {
    id: "read",
    icon: BookOpen,
    title: "读书伙伴",
    desc: "不替你总结，陪你把一本书读深。先解剖：这本书在反对谁、思想谱系是什么、争议在哪；再一章一章陪你聊。",
    points: ["按论证逻辑拆解，不照搬目录", "每章带其他思想家的交叉视角", "聊出来的洞见自动进第二大脑"],
  },
  {
    id: "council",
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

const NAV_LINKS = [
  { href: "#coach", label: "教练" },
  { href: "#brain", label: "大脑" },
  { href: "#read", label: "读书" },
  { href: "#council", label: "圆桌" },
];

const TYPE_TEXT = "很高兴你来了。会学习的人，最后总会走到这里。现在，你想学会什么？";

export default function Landing() {
  const { displayed, done } = useTypewriter(TYPE_TEXT, 38, 600);
  const [showPills, setShowPills] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  /* 药丸：载入 400ms 后淡入上滑（不等打字机） */
  useEffect(() => {
    const t = setTimeout(() => setShowPills(true), 400);
    return () => clearTimeout(t);
  }, []);

  const copyEmail = async () => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(CONTACT_EMAIL);
    } catch {
      /* 剪贴板 API 被拒 → 降级 execCommand */
      try {
        const ta = document.createElement("textarea");
        ta.value = CONTACT_EMAIL;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      } catch {
        ok = false;
      }
    }
    setCopied(ok);
    setTimeout(() => setCopied(false), 2400);
  };

  return (
    <div className="min-h-screen">
      <HeroVideo />

      {/* ===== 导航栏（fixed，z-10） ===== */}
      <header className="fixed top-0 z-10 flex w-full items-center justify-between px-5 py-4 sm:px-8 sm:py-5">
        <Link href="/" className="flex items-baseline gap-3">
          <span className="font-brand text-[26px] leading-none text-white sm:text-[30px]">Mentora</span>
          <span
            className="select-none text-[25px] leading-none text-white sm:text-[30px]"
            style={{ letterSpacing: "-0.02em" }}
          >
            ✳︎
          </span>
        </Link>

        {/* 桌面导航（md+ 居中） */}
        <nav className="hidden items-center text-[23px] text-white md:flex">
          {NAV_LINKS.map((l, i) => (
            <span key={l.href} className="flex items-center">
              {i > 0 && <span className="text-white/80">, </span>}
              <a href={l.href} className="transition-opacity hover:opacity-60">
                {l.label}
              </a>
            </span>
          ))}
        </nav>

        {/* 桌面 CTA */}
        <div className="hidden md:block">
          <Link
            href="/login"
            className="text-[23px] text-white underline underline-offset-2 transition-opacity hover:opacity-60"
          >
            登录
          </Link>
        </div>

        {/* 移动端汉堡（md 以下） */}
        <button
          type="button"
          aria-label="菜单"
          onClick={() => setMenuOpen((v) => !v)}
          className="flex cursor-pointer flex-col gap-[5px] md:hidden"
        >
          <span
            className="block h-[2px] w-6 bg-white transition-all duration-300"
            style={menuOpen ? { transform: "rotate(45deg) translateY(7px)" } : undefined}
          />
          <span
            className="block h-[2px] w-6 bg-white transition-all duration-300"
            style={menuOpen ? { opacity: 0 } : undefined}
          />
          <span
            className="block h-[2px] w-6 bg-white transition-all duration-300"
            style={menuOpen ? { transform: "rotate(-45deg) translateY(-7px)" } : undefined}
          />
        </button>
      </header>

      {/* 移动端全屏菜单（z-9） */}
      <div
        className="fixed inset-0 z-[9] flex flex-col items-start justify-center bg-black/90 px-8 backdrop-blur-md md:hidden"
        style={{
          opacity: menuOpen ? 1 : 0,
          pointerEvents: menuOpen ? "auto" : "none",
          transition: "opacity 300ms ease",
        }}
      >
        {NAV_LINKS.map((l) => (
          <a
            key={l.href}
            href={l.href}
            onClick={() => setMenuOpen(false)}
            className="py-2 text-[32px] font-medium text-white"
          >
            {l.label}
          </a>
        ))}
        <Link
          href="/login"
          onClick={() => setMenuOpen(false)}
          className="mt-2 text-[32px] font-medium text-white underline underline-offset-2"
        >
          登录
        </Link>
      </div>

      {/* ===== Hero（z-1，整屏） ===== */}
      <section className="relative z-[1] flex h-screen flex-col justify-end overflow-hidden px-5 pb-12 sm:px-8 md:justify-center md:px-10 md:pb-0">
        <div className="relative z-10 max-w-xl">
          {/* 磨砂引言（blur 4px） */}
          <p
            className="font-body-display pointer-events-none mb-5 select-none text-white sm:mb-6"
            style={{ fontSize: "clamp(18px, 4vw, 26px)", lineHeight: 1.3, filter: "blur(4px)" }}
          >
            嘿，来见见 Mentora —
            <br />
            把「学会任何东西」变成日常的系统
          </p>

          {/* 打字机 */}
          <p
            className="font-body-display mb-5 text-white sm:mb-6"
            style={{ fontSize: "clamp(18px, 4vw, 26px)", lineHeight: 1.35, minHeight: 54 }}
          >
            {displayed}
            {!done && <span className="type-cursor" />}
          </p>

          {/* 药丸按钮：400ms 后淡入上滑 */}
          <div
            className="flex flex-wrap gap-y-1"
            style={{
              opacity: showPills ? 1 : 0,
              transform: showPills ? "none" : "translateY(8px)",
              transition: "opacity 0.4s ease, transform 0.4s ease",
            }}
          >
            <Pill href="/login?mode=register">说出你想学的</Pill>
            <Pill href="#method">看看怎么运转</Pill>
            <Pill href="#council">认识 12 位伙伴</Pill>
            <Pill href="#read">读一本书试试</Pill>
            <Pill outline onClick={copyEmail}>
              <span className="underline underline-offset-1">{CONTACT_EMAIL}</span>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                <rect x="0.5" y="0.5" width="7" height="7" rx="1" stroke="currentColor" />
                <rect x="4.5" y="4.5" width="7" height="7" rx="1" stroke="currentColor" />
              </svg>
              {copied && <span className="text-[11px] opacity-70">已复制</span>}
            </Pill>
          </div>
        </div>
      </section>

      {/* ===== 下方产品区（实底盖住 fixed 视频） ===== */}
      <div className="relative z-[1] border-t border-white/10 bg-bg">
        {/* 四大功能 */}
        <section className="mx-auto max-w-5xl px-4 py-20">
          <div className="grid gap-4 md:grid-cols-2">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                id={f.id}
                className="scroll-mt-24 rounded-2xl border border-border bg-surface p-6 transition-shadow hover:shadow-[0_8px_32px_-12px_rgba(0,0,0,0.15)]"
              >
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-white text-accent">
                    <f.icon className="size-5" strokeWidth={1.75} />
                  </div>
                  <h3 className="font-heading text-base font-bold text-ink">{f.title}</h3>
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
        <section id="method" className="scroll-mt-16 border-y border-border bg-surface/50 px-4 py-16">
          <div className="mx-auto max-w-4xl">
            <h2 className="font-heading text-center text-xl font-bold tracking-[-0.02em] text-ink">
              三步，开始认真学一样东西
            </h2>
            <div className="mt-10 grid gap-8 md:grid-cols-3">
              {STEPS.map((s) => (
                <div key={s.n}>
                  <p className="tabular text-3xl font-extrabold text-accent/40">{s.n}</p>
                  <h3 className="font-heading mt-2 text-base font-bold text-ink">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-dim">{s.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 态度 */}
        <section className="mx-auto max-w-3xl px-4 py-20 text-center">
          <p className="font-heading text-lg leading-relaxed text-ink">它不负责哄你开心，负责让你变清醒。</p>
          <p className="mt-3 text-sm leading-relaxed text-ink-dim">
            第一句话就是判断，没有「取决于」和「各有道理」。
            你错的时候它直说，你焦虑的时候它把情绪翻译成可以动手做的事。
          </p>
          <Link
            href="/login?mode=register"
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-[#1a1a1a] px-6 py-3 text-[15px] font-medium text-white transition-colors duration-200 hover:bg-black/80"
          >
            说出你想学的东西 <ArrowRight className="size-4" />
          </Link>
        </section>

        <footer className="border-t border-border px-4 py-8 text-center text-xs text-ink-dim/60">
          <span className="font-brand mr-1.5 text-[16px] align-middle text-ink">Mentora</span>✳︎
          <span className="mx-2">·</span>
          学习教练 × 第二大脑 × 读书伙伴 × 人生伙伴
        </footer>
      </div>
    </div>
  );
}
