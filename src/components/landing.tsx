"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  BookOpen, Brain, Compass, GraduationCap,
  ArrowRight, ArrowDown, Check, ShieldCheck,
} from "lucide-react";

/* ============================================================
 * Mentora Landing —— 暗夜电影感首页
 * 结构参考 Mainframe 式 full-screen hero：
 *   鼠标横移 scrub 视频背景 / 模糊引言标签 / 打字机正文 / 胶囊按钮
 * 降级策略：
 *   - 视频加载失败 → 纯深色渐变底
 *   - 触屏设备（无鼠标）→ 视频静音循环自动播放
 *   - prefers-reduced-motion → 关闭 scrub 与打字机，直出全文
 * ============================================================ */

/* 本地化托管：原 CloudFront 源（810KB）已下载到 public，避免跨境 CDN 首屏黑屏 */
const VIDEO_SRC = "/hero.mp4";

/* ---------- 打字机 ---------- */
function useTypewriter(text: string, speed = 38, startDelay = 600) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    let i = 0;
    const timeout = setTimeout(() => {
      interval = setInterval(() => {
        i += 1;
        setDisplayed(text.slice(0, i));
        if (i >= text.length) {
          if (interval) clearInterval(interval);
          setDone(true);
        }
      }, speed);
    }, startDelay);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [text, speed, startDelay]);

  return { displayed, done };
}

/* ---------- 鼠标 scrub 视频 ---------- */
function useScrubVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoOk, setVideoOk] = useState(true);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const finePointer = window.matchMedia("(pointer: fine)").matches;

    const onError = () => setVideoOk(false);
    video.addEventListener("error", onError);

    // 触屏 / 减弱动态：静音循环播放（或干脆静止海报帧）
    if (!finePointer || reduceMotion) {
      if (!reduceMotion) {
        video.loop = true;
        void video.play().catch(() => setVideoOk(false));
      }
      return () => video.removeEventListener("error", onError);
    }

    // 桌面鼠标：横移 scrub
    const SENSITIVITY = 0.8;
    let prevX: number | null = null;
    let targetTime = 0.4;
    let seeking = false;

    // 首帧定为 0.4s：避开 t=0 的黑场淡入
    const onMeta = () => {
      if (video.duration) video.currentTime = Math.min(0.4, video.duration - 0.05);
    };
    video.addEventListener("loadedmetadata", onMeta);

    const onSeeked = () => {
      if (Math.abs(video.currentTime - targetTime) > 0.04 && video.duration) {
        video.currentTime = Math.min(targetTime, video.duration - 0.05);
      } else {
        seeking = false;
      }
    };

    const onMove = (e: MouseEvent) => {
      if (prevX === null) {
        prevX = e.clientX;
        return;
      }
      const delta = e.clientX - prevX;
      prevX = e.clientX;
      if (!video.duration) return;
      targetTime = Math.max(
        0,
        Math.min(
          targetTime + (delta / window.innerWidth) * SENSITIVITY * video.duration,
          video.duration - 0.05
        )
      );
      if (!seeking) {
        seeking = true;
        video.currentTime = targetTime;
      }
    };

    video.addEventListener("seeked", onSeeked);
    window.addEventListener("mousemove", onMove);
    return () => {
      video.removeEventListener("error", onError);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("seeked", onSeeked);
      window.removeEventListener("mousemove", onMove);
    };
  }, []);

  return { videoRef, videoOk };
}

/* ---------- 内容数据 ---------- */
const TYPE_TEXT =
  "想学的东西，说出来。计划它排，验收它盯，学不会它直说。现在，从哪一门开始？";

const NAV_LINKS = [
  { label: "学习教练", href: "/login" },
  { label: "第二大脑", href: "/login" },
  { label: "读书伙伴", href: "/login" },
  { label: "人生伙伴", href: "/login" },
];

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

/* ---------- 胶囊按钮 ---------- */
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
    ? "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full border border-white/70 bg-transparent px-4 py-[0.35em] text-[13px] text-white transition-colors duration-200 hover:bg-white hover:text-black sm:px-5 sm:text-[15px]"
    : "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full border border-black/10 bg-white px-4 py-[0.35em] text-[13px] text-black transition-colors duration-200 hover:bg-black hover:text-white sm:px-5 sm:text-[15px]";
  if (href) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

/* ---------- 移动端汉堡菜单 ---------- */
function MobileNav() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        aria-label="菜单"
        onClick={() => setOpen(!open)}
        className="flex flex-col gap-[5px] md:hidden"
      >
        <span
          className={`h-[2px] w-6 bg-white transition-all duration-300 ${open ? "translate-y-[7px] rotate-45" : ""}`}
        />
        <span className={`h-[2px] w-6 bg-white transition-opacity duration-300 ${open ? "opacity-0" : ""}`} />
        <span
          className={`h-[2px] w-6 bg-white transition-all duration-300 ${open ? "-translate-y-[7px] -rotate-45" : ""}`}
        />
      </button>
      <div
        className={`fixed inset-0 z-[9] flex flex-col justify-center gap-8 bg-black/90 px-8 backdrop-blur-md transition-opacity duration-300 md:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        {NAV_LINKS.map((l) => (
          <Link
            key={l.label}
            href={l.href}
            onClick={() => setOpen(false)}
            className="text-[32px] font-medium text-white"
          >
            {l.label}
          </Link>
        ))}
        <Link
          href="/login?mode=register"
          onClick={() => setOpen(false)}
          className="text-[32px] font-medium text-white underline underline-offset-4"
        >
          免费开始
        </Link>
      </div>
    </>
  );
}

export default function Landing() {
  const { videoRef, videoOk } = useScrubVideo();
  const { displayed, done } = useTypewriter(TYPE_TEXT);
  const [pillsIn, setPillsIn] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setPillsIn(true), 400);
    return () => clearTimeout(t);
  }, []);

  const scrollToFeatures = () => {
    document.getElementById("features")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="bg-[#0a0a0b] text-white">
      {/* ===== Hero：整屏 ===== */}
      <section className="relative flex h-screen flex-col overflow-hidden">
        {/* 底层渐变（视频加载失败时的兜底）——必须在视频之下 */}
        <div
          className="pointer-events-none fixed inset-0 z-0"
          style={{
            background:
              "radial-gradient(ellipse 80% 60% at 30% 40%, rgba(91,84,230,0.22) 0%, transparent 60%), radial-gradient(ellipse 90% 90% at 50% 60%, #141416 0%, #0a0a0b 70%)",
          }}
        />
        {/* 视频背景（失败时移除，露出底层渐变） */}
        {videoOk && (
          <video
            ref={videoRef}
            src={VIDEO_SRC}
            muted
            playsInline
            preload="auto"
            className="fixed inset-0 z-0 h-full w-full object-cover"
            style={{ objectPosition: "70% center" }}
          />
        )}
        {/* 压暗罩：桌面左深右浅（文案在左）；移动端自下而上（文案沉底） */}
        <div className="pointer-events-none fixed inset-0 z-[1] bg-gradient-to-t from-black/90 via-black/55 to-black/15 md:bg-gradient-to-r md:from-black/80 md:via-black/45 md:to-black/25" />

        {/* 导航 */}
        <header className="relative z-10 flex items-center justify-between px-5 py-4 sm:px-8 sm:py-5">
          <Link href="/" className="flex items-baseline gap-2">
            <span className="font-brand text-[26px] leading-none text-white sm:text-[30px]">
              Mentora
            </span>
            <span className="select-none text-[13px] tracking-[-0.02em] text-white/70">®</span>
          </Link>
          <nav className="hidden items-center text-[15px] text-white md:flex">
            {NAV_LINKS.map((l, i) => (
              <span key={l.label} className="flex items-center">
                {i > 0 && <span className="mx-1 text-white/50">,</span>}
                <Link href={l.href} className="transition-opacity hover:opacity-60">
                  {l.label}
                </Link>
              </span>
            ))}
          </nav>
          <Link
            href="/login"
            className="hidden text-[15px] text-white underline underline-offset-2 transition-opacity hover:opacity-60 md:block"
          >
            进入
          </Link>
          <MobileNav />
        </header>

        {/* Hero 正文 */}
        <div className="relative z-10 flex flex-1 flex-col justify-end px-5 pb-14 sm:px-8 md:justify-center md:px-10 md:pb-0">
          <div className="max-w-xl">
            <p
              className="pointer-events-none mb-5 select-none text-white sm:mb-6"
              style={{
                fontSize: "clamp(18px, 4vw, 26px)",
                lineHeight: 1.3,
                filter: "blur(4px)",
              }}
            >
              嘿，你到这儿了——
              <br />
              一个把「学会任何东西」变成日常的系统
            </p>
            <p
              className="mb-5 text-white sm:mb-6"
              style={{
                fontSize: "clamp(18px, 4vw, 26px)",
                lineHeight: 1.35,
                minHeight: "72px",
              }}
            >
              {displayed}
              {!done && (
                <span
                  className="ml-[2px] inline-block h-[1.1em] w-[2px] bg-white align-middle"
                  style={{ animation: "blink 1s step-end infinite" }}
                />
              )}
            </p>
            <div
              className="flex flex-wrap gap-y-1"
              style={{
                opacity: pillsIn ? 1 : 0,
                transform: pillsIn ? "none" : "translateY(8px)",
                transition: "opacity 0.4s ease, transform 0.4s ease",
              }}
            >
              <Pill href="/login?mode=register">免费开始</Pill>
              <Pill href="/login">我有账号</Pill>
              <Pill onClick={scrollToFeatures}>
                看看它怎么工作 <ArrowDown className="size-3.5" />
              </Pill>
              <Pill outline>
                <ShieldCheck className="size-3.5" /> 不注册也能用 · 数据留在本机
              </Pill>
            </div>
          </div>
        </div>

        {/* 底部滚动提示 */}
        <div className="relative z-10 hidden justify-center pb-6 md:flex">
          <button
            onClick={scrollToFeatures}
            className="text-white/40 transition-colors hover:text-white/80"
            aria-label="向下滚动"
          >
            <ArrowDown className="size-5 animate-bounce" />
          </button>
        </div>
      </section>

      {/* ===== 四大功能（深色续场） ===== */}
      <section id="features" className="relative z-10 border-t border-white/10 bg-[#0a0a0b] px-5 py-20 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/40">
            四个角色，一个系统
          </p>
          <h2 className="mt-3 text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
            它不哄你开心，它让你变清醒。
          </h2>
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition-colors duration-200 hover:border-white/20 hover:bg-white/[0.05]"
              >
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-xl border border-white/15 bg-white/[0.06] text-white">
                    <f.icon className="size-5" strokeWidth={1.75} />
                  </div>
                  <h3 className="text-base font-bold">{f.title}</h3>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-white/60">{f.desc}</p>
                <ul className="mt-4 space-y-1.5">
                  {f.points.map((pt) => (
                    <li key={pt} className="flex items-start gap-2 text-[13px] text-white/55">
                      <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
                      {pt}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== 三步 ===== */}
      <section className="relative z-10 border-t border-white/10 bg-[#0a0a0b] px-5 py-20 sm:px-8">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-center text-xl font-bold tracking-[-0.02em] sm:text-2xl">
            三步，开始认真学一样东西
          </h2>
          <div className="mt-12 grid gap-10 md:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n}>
                <p className="tabular text-3xl font-extrabold text-white/25">{s.n}</p>
                <h3 className="mt-2 text-base font-bold">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-white/55">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== 收尾 CTA ===== */}
      <section className="relative z-10 border-t border-white/10 bg-[#0a0a0b] px-5 py-24 text-center sm:px-8">
        <p className="mx-auto max-w-2xl text-lg leading-relaxed sm:text-xl">
          第一句话就是判断，没有「取决于」和「各有道理」。
        </p>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-white/50">
          你错的时候它直说，你焦虑的时候它把情绪翻译成可以动手做的事。
        </p>
        <Link
          href="/login?mode=register"
          className="mt-9 inline-flex items-center gap-2 rounded-full bg-white px-7 py-3 text-[15px] font-medium text-black transition-colors duration-200 hover:bg-black hover:text-white hover:ring-1 hover:ring-white"
        >
          说出你想学的东西 <ArrowRight className="size-4" />
        </Link>
      </section>

      <footer className="relative z-10 border-t border-white/10 bg-[#0a0a0b] px-5 py-8 text-center text-xs text-white/35">
        Mentora · 学习教练 × 第二大脑 × 读书伙伴 × 人生伙伴
      </footer>
    </div>
  );
}
