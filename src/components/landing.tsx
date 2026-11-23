"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTypewriter } from "@/lib/use-typewriter";
import { usePopText } from "@/lib/use-poptext";
import { QRCodeSVG } from "qrcode.react";
import { ArrowRight, BookOpen, Brain, Check, Compass, GraduationCap } from "lucide-react";
import { Input, Modal, Textarea } from "@/components/ui";
import { PLANS, priceLabel } from "@/lib/pricing";
import { copyText } from "@/lib/utils";
import { toast } from "sonner";

/* ================= Mainframe 规格资产 ================= */

const VIDEO_SRC = "/hero.mp4";
const SENSITIVITY = 0.8; // 鼠标横向移动 → 视频时间轴的灵敏度
const CONTACT_EMAIL = "hi@mentora.app";

/** 鼠标横向擦洗控制的背景视频（不自动播放，onSeeked 排队防 seek 洪泛）
 *  active=false 表示 hero 已被下方实底内容完全盖住：视频不可见时横向移动鼠标
 *  不应再改 currentTime——preload="metadata" 下每次 seek 都可能发起媒体 range
 *  请求 + 解码，全是给看不见的画面白耗带宽与电量。 */
function HeroVideo({ active }: { active: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  /* 用 ref 而非把 active 放进下面 effect 的依赖：滚动会让 active 反复翻转，
   * 重挂 window 监听没有必要，监听器内部读最新值即可。 */
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

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
        /* 快滚离开首屏后才 loadeddata 的话，别为看不见的画面补这一刀 seek；
         * target 已记下，滚回后第一次移动会 seek 到它。 */
        if (!activeRef.current) return;
        video.currentTime = target;
        seeking = true;
      }
    };
    const applySeek = () => {
      /* hero 不可见时不发 seek：onSeeked 的重试分支也会走到这里 */
      if (!activeRef.current) return;
      if (seeking || !video.duration) return;
      seeking = true;
      video.currentTime = target;
    };
    const onSeeked = () => {
      seeking = false;
      if (Math.abs(video.currentTime - target) > 0.05) applySeek();
    };
    const onMove = (e: MouseEvent) => {
      if (!activeRef.current) {
        /* 不可见：不累计位移、不 seek；但仍同步 prevX，
         * 否则滚回 hero 后第一次移动会用旧起点算出一个大跳。 */
        prevX = e.clientX;
        return;
      }
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

  const [playable, setPlayable] = useState(false);

  return (
    <>
      {/* 兜底层：深色底 + 海报图。视频失败/浏览器不支持解码/被拦截时显示海报,绝不黑屏 */}
      <div className="fixed inset-0 z-0 bg-ink" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/hero-poster.jpg"
        alt=""
        aria-hidden
        className="fixed inset-0 z-0 h-full w-full object-cover"
        style={{ objectPosition: "70% center" }}
      />
      {/* v17：preload 降为 metadata——起播即可擦洗（range 按需取段），不再无条件拉 792KB 首包 */}
      <video
        ref={ref}
        src={VIDEO_SRC}
        poster="/hero-poster.jpg"
        muted
        playsInline
        preload="metadata"
        onLoadedData={() => setPlayable(true)}
        onError={(e) => {
          /* 加载/解码失败:隐藏视频,露出海报兜底(不黑屏) */
          e.currentTarget.style.display = "none";
        }}
        className="fixed inset-0 z-0 h-full w-full object-cover transition-opacity duration-500"
        style={{
          objectPosition: "70% center",
          filter: "brightness(1.06) contrast(1.04)",
          opacity: playable ? 1 : 0, // 未可播前透明,避免首帧暗场=黑屏
        }}
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
    /* 站内路由走 next/link（客户端路由+预取）：hero 的「我有激活码」此前用原生 <a>，
     * 与桌面 CTA / 移动菜单 / 定价卡到同一目的地（/login?mode=register）的 Link 行为
     * 不一致——一处秒开一处整页白屏重载。纯页内锚点（#method/#pricing）保持原生 <a>。 */
    if (href.startsWith("/")) {
      return (
        <Link href={href} onClick={onClick} className={`${cls} ${size}`}>
          {children}
        </Link>
      );
    }
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
    points: ["验收通过的知识点自动入库", "FSRS 按你的遗忘曲线排复习", "自动帮你找到笔记之间隐藏的联系"],
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
  { href: "#pricing", label: "价格" },
];

const TYPE_TEXT = "很高兴你来了。会学习的人，最后总会走到这里。现在，你想学会什么？";

export default function Landing() {
  const { displayed, done } = useTypewriter(TYPE_TEXT, 38, 600);
  const { elRef: popRef, failed: popFailed } = usePopText("Mentora", 300);
  const [showPills, setShowPills] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /* 顶栏滚动感知：浅色产品区实底滚到视口顶后，fixed 顶栏从「白字无底」切换为
   * 玻璃浅底+墨色字（glass-chrome 配方同 app-shell 吸顶栏）——否则白字压在
   * bg-bg(#f5f5f7) 上对比度≈1.05:1，logo/导航/登录/汉堡全部不可读。
   * 用实底容器 rect 而非 window.innerHeight：移动端 100vh 与动态视口有差。 */
  const solidRef = useRef<HTMLDivElement>(null);
  const [pastHero, setPastHero] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      const el = solidRef.current;
      setPastHero(!!el && el.getBoundingClientRect().top <= 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);
  const [copyNote, setCopyNote] = useState(""); // 空串=无提示；成功/失败都让读屏与视力用户感知到
  const [trialOpen, setTrialOpen] = useState(false);
  const [trialEmail, setTrialEmail] = useState("");
  const [trialContact, setTrialContact] = useState("");
  const [trialNote, setTrialNote] = useState("");
  const [trialBusy, setTrialBusy] = useState(false);
  const [trialSent, setTrialSent] = useState(false);

  /* 药丸：载入 400ms 后淡入上滑（不等打字机） */
  useEffect(() => {
    const t = setTimeout(() => setShowPills(true), 400);
    return () => clearTimeout(t);
  }, []);

  /* 「已复制」提示的清空定时器：同文件其它定时器（243 行、use-typewriter）都做了
   * 卸载清理，这里同样持有句柄、卸载时清除（回调在已卸载组件上 setState 是卫生问题）。 */
  const copyNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyNoteTimer.current) clearTimeout(copyNoteTimer.current);
    },
    []
  );

  const copyEmail = async () => {
    /* 复制降级链统一走 lib/utils 的 copyText（clipboard→execCommand，带 readonly 防
     * iOS 聚焦弹键盘）：本组件不再手抄一份，两份并存日后修 bug 必漏一处 */
    const ok = await copyText(CONTACT_EMAIL);
    setCopyNote(ok ? "已复制" : "复制失败，请手动选择邮箱");
    if (copyNoteTimer.current) clearTimeout(copyNoteTimer.current);
    copyNoteTimer.current = setTimeout(() => setCopyNote(""), 2400);
  };

  const submitTrial = async () => {
    if (trialBusy) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trialEmail.trim())) {
      toast.error("邮箱看起来不太对");
      return;
    }
    setTrialBusy(true);
    try {
      const res = await fetch("/api/trial-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trialEmail.trim(), contact: trialContact.trim(), note: trialNote.trim() }),
        /* 弱网/连接停滞下不设超时 fetch 可挂起数分钟，trialBusy 恒 true——提交按钮
         * 永远「提交中…」且 disabled，关掉弹窗再开也不恢复（openTrial 不重置它）。
         * 15s 与 feedback-widget 等全站客户端 fetch 的超时纪律一致；超时走 catch
         * 提示、finally 复位 trialBusy，用户可以重试。 */
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "提交失败");
      }
      setTrialSent(true);
    } catch (e) {
      /* AbortSignal.timeout 抛的 DOMException 原文是英文（TimeoutError），翻译成可读文案 */
      toast.error(
        e instanceof DOMException && e.name === "TimeoutError"
          ? "提交超时，请检查网络后重试"
          : e instanceof Error
            ? e.message
            : "提交失败"
      );
    } finally {
      setTrialBusy(false);
    }
  };

  const openTrial = () => {
    setTrialSent(false);
    setTrialOpen(true);
  };

  return (
    <div className="min-h-screen">
      {/* pastHero 即「下方实底已盖住 hero」——用它同时作为视频擦洗的可见性开关 */}
      <HeroVideo active={!pastHero} />

      {/* ===== 导航栏（fixed，z-10） ===== */}
      <header
        className={`fixed top-0 z-10 flex w-full items-center justify-between px-5 py-4 transition-[background-color,backdrop-filter] duration-300 sm:px-8 sm:py-5 ${
          pastHero ? "glass-chrome" : ""
        }`}
      >
        <Link href="/" className="flex items-baseline gap-3">
          <span
            className={`font-brand text-[26px] leading-none transition-colors duration-300 sm:text-[30px] ${
              pastHero ? "text-ink" : "text-white"
            }`}
          >
            Mentora
          </span>
          <span
            className={`select-none text-[25px] leading-none transition-colors duration-300 sm:text-[30px] ${
              pastHero ? "text-ink" : "text-white"
            }`}
            style={{ letterSpacing: "-0.02em" }}
          >
            ✳︎
          </span>
        </Link>

        {/* 桌面导航（md+ 居中） */}
        <nav
          className={`hidden items-center text-[23px] transition-colors duration-300 md:flex ${
            pastHero ? "text-ink" : "text-white"
          }`}
        >
          {NAV_LINKS.map((l, i) => (
            <span key={l.href} className="flex items-center">
              {i > 0 && <span className={pastHero ? "text-ink/70" : "text-white/80"}>, </span>}
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
            className={`text-[23px] underline underline-offset-2 transition-opacity hover:opacity-60 ${
              pastHero ? "text-ink" : "text-white"
            }`}
          >
            登录
          </Link>
        </div>

        {/* 移动端汉堡（md 以下） */}
        <button
          type="button"
          aria-label="菜单"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          className="flex cursor-pointer flex-col gap-[5px] md:hidden"
        >
          <span
            className={`block h-[2px] w-6 transition-all duration-300 ${pastHero ? "bg-ink" : "bg-white"}`}
            style={menuOpen ? { transform: "rotate(45deg) translateY(7px)" } : undefined}
          />
          <span
            className={`block h-[2px] w-6 transition-all duration-300 ${pastHero ? "bg-ink" : "bg-white"}`}
            style={menuOpen ? { opacity: 0 } : undefined}
          />
          <span
            className={`block h-[2px] w-6 transition-all duration-300 ${pastHero ? "bg-ink" : "bg-white"}`}
            style={menuOpen ? { transform: "rotate(-45deg) translateY(-7px)" } : undefined}
          />
        </button>
      </header>

      {/* 移动端全屏菜单（z-9）。v17：收起态移出 tab 序与可访问树（此前 opacity 隐藏
       *  但链接仍可聚焦/朗读）——React 19 原生支持 inert。 */}
      <div
        className="fixed inset-0 z-[9] flex flex-col items-start justify-center bg-black/90 px-8 backdrop-blur-md md:hidden"
        style={{
          opacity: menuOpen ? 1 : 0,
          pointerEvents: menuOpen ? "auto" : "none",
          transition: "opacity 300ms ease",
        }}
        aria-hidden={!menuOpen}
        inert={!menuOpen}
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
          {/* 品牌大字：PopText 手写体，逐字弹入，划过字母变专属 3D 物件 */}
          <h1
            ref={popRef}
            className="pop-text font-brand pointer-events-auto mb-3 select-none leading-none text-white sm:mb-5"
            style={{ fontSize: "clamp(76px, 10vw, 132px)", minHeight: "1.25em" }}
            aria-label="Mentora"
          >
            {/* PopText 加载失败时 h1 无文本子节点会永久空白：渲染纯文本兜底（成功路径无此节点，视觉不变） */}
            {popFailed && "Mentora"}
          </h1>

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
            aria-label={TYPE_TEXT}
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
            <Pill onClick={openTrial}>申请 7 天体验</Pill>
            <Pill href="/login?mode=register" outline>
              我有激活码
            </Pill>
            <Pill href="#method">看看怎么运转</Pill>
            <Pill href="#pricing">价格</Pill>
            <Pill outline onClick={copyEmail}>
              <span className="underline underline-offset-1">{CONTACT_EMAIL}</span>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                <rect x="0.5" y="0.5" width="7" height="7" rx="1" stroke="currentColor" />
                <rect x="4.5" y="4.5" width="7" height="7" rx="1" stroke="currentColor" />
              </svg>
              <span aria-live="polite">
                {copyNote && <span className="text-[11px] opacity-70">{copyNote}</span>}
              </span>
            </Pill>
          </div>
        </div>
      </section>

      {/* ===== 下方产品区（实底盖住 fixed 视频） ===== */}
      <div ref={solidRef} className="relative z-[1] border-t border-white/10 bg-bg">
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

        {/* 定价：买一张激活码，兑换后计时；续费在原到期日上累加 */}
        <section id="pricing" className="scroll-mt-16 border-y border-border bg-surface/50 px-4 py-16">
          <div className="mx-auto max-w-4xl">
            <h2 className="font-heading text-center text-xl font-bold tracking-[-0.02em] text-ink">
              一张激活码，换一段认真学的时间
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-center text-sm leading-relaxed text-ink-dim">
              没有自动续费，也不会偷偷扣款。到期前会提醒你；到期后笔记和数据都还在，随时可以导出。
              <br />
              已经有账号了？把会员页里的邀请码发给朋友，他注册时填上，<b className="text-ink">你多一个月</b>。
            </p>
            <div className="mt-10 grid gap-4 md:grid-cols-2">
              {(["month", "year"] as const).map((id) => {
                const p = PLANS[id];
                return (
                  <div
                    key={id}
                    className={`relative rounded-2xl border bg-white p-6 ${
                      id === "year" ? "border-accent/40 shadow-[0_8px_32px_-16px_rgba(120,100,255,0.45)]" : "border-border"
                    }`}
                  >
                    {id === "year" && (
                      <span className="absolute -top-2.5 left-5 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-white">
                        更划算
                      </span>
                    )}
                    <p className="font-heading text-base font-bold text-ink">{p.name}</p>
                    <p className="mt-3 flex items-baseline gap-1">
                      <span className="text-4xl font-bold tracking-tight text-ink">¥{priceLabel(p.price)}</span>
                      <span className="text-xs text-ink-dim">/ {p.days === 30 ? "月" : "年"}</span>
                    </p>
                    <p className="mt-2 text-xs leading-relaxed text-ink-dim">{p.tagline}</p>
                    <ul className="mt-4 space-y-1.5">
                      {["教练 / 第二大脑 / 读书 / 圆桌 全部功能", "换设备登录同一账号即可恢复", "到期自动转免费版：数据保留，AI 限免费额度"].map((t) => (
                        <li key={t} className="flex items-start gap-2 text-[13px] text-ink-dim">
                          <Check className="mt-0.5 size-3.5 shrink-0 text-ok" />
                          {t}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-5 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={openTrial}
                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-black/80"
                      >
                        先试 7 天 <ArrowRight className="size-3.5" />
                      </button>
                      <Link
                        href="/login?mode=register"
                        className="inline-flex items-center rounded-full border border-border px-4 py-2 text-[13px] text-ink transition-colors hover:bg-black/[0.04]"
                      >
                        我有激活码
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mx-auto mt-10 max-w-2xl space-y-3">
              {[
                {
                  q: "到期后会怎样？",
                  a: "自动转入免费版：账号、学习计划、笔记和导出都保留；AI 按月度免费额度受限，学习教练限前两个阶段。续费一张新卡密，天数从原到期日往后累加，完整额度立刻恢复。",
                },
                {
                  q: "数据归谁？",
                  a: "归你。密码单向加密、云端数据加密存储，随时可以一键导出全部内容带走。",
                },
                {
                  q: "换设备要再买吗？",
                  a: "不用。登录同一个账号，数据自动同步；时长跟着账号走，不跟设备走。",
                },
              ].map((f) => (
                <div key={f.q} className="rounded-xl border border-border bg-white px-4 py-3">
                  <p className="text-[13px] font-semibold text-ink">{f.q}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-dim">{f.a}</p>
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
          <button
            type="button"
            onClick={openTrial}
            className="mt-8 inline-flex cursor-pointer items-center gap-2 rounded-full bg-ink px-6 py-3 text-[15px] font-medium text-white transition-colors duration-200 hover:bg-black/80"
          >
            申请 7 天体验 <ArrowRight className="size-4" />
          </button>
        </section>

        <footer className="border-t border-border px-4 py-10 text-center text-xs text-ink-dim/60">
          <div className="mx-auto mb-5 inline-flex flex-col items-center gap-2.5">
            <div className="rounded-xl border border-border bg-white p-2.5">
              <QRCodeSVG value={typeof window !== "undefined" ? window.location.origin : "https://mentora-orpin.vercel.app"} size={88} />
            </div>
            <p>手机扫码，马上开始</p>
          </div>
          <div>
            <span className="font-brand mr-1.5 text-[16px] align-middle text-ink">Mentora</span>✳︎
            <span className="mx-2">·</span>
            学习教练 × 第二大脑 × 读书伙伴 × 人生伙伴
          </div>
        </footer>
      </div>

      {/* 体验申请：留资 → 后台一键发码（冷启动阶段每个申请都过一遍人眼） */}
      <Modal open={trialOpen} onClose={() => setTrialOpen(false)} title={trialSent ? "申请收到" : "申请 7 天体验"}>
        {trialSent ? (
          <div className="py-2">
            <p className="text-sm leading-relaxed text-ink">
              收到，我会尽快把 7 天体验码发到 <b>{trialEmail}</b>
              {trialContact ? `（或通过 ${trialContact}）` : ""}。
            </p>
            <p className="mt-2 text-xs leading-relaxed text-ink-dim">
              如果半天内没收到，直接写信到 {CONTACT_EMAIL}，别干等。
            </p>
            <button
              type="button"
              onClick={() => setTrialOpen(false)}
              className="mt-5 w-full cursor-pointer rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-black/80"
            >
              好
            </button>
          </div>
        ) : (
          <div className="space-y-3 py-1">
            <p className="text-[13px] leading-relaxed text-ink-dim">
              留下邮箱，我人工发一张 7 天体验码给你。不需要绑卡，也不会自动续费。
            </p>
            <label className="block text-xs text-ink-dim">
              邮箱（必填）
              {/* 复用共享 Input/Textarea（ui.tsx）：移动端 16px 防 iOS 聚焦自动放大、
                  44px 触达高度与全站焦点环口径一致——手抄 text-sm 三处全违反该契约 */}
              <Input
                type="email"
                value={trialEmail}
                onChange={(e) => setTrialEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-1.5"
              />
            </label>
            <label className="block text-xs text-ink-dim">
              微信 / 手机（可选，方便直接发你）
              <Input
                value={trialContact}
                onChange={(e) => setTrialContact(e.target.value)}
                placeholder="微信号或手机号"
                className="mt-1.5"
              />
            </label>
            <label className="block text-xs text-ink-dim">
              想学什么？（可选，我会按你的目标给建议）
              <Textarea
                value={trialNote}
                onChange={(e) => setTrialNote(e.target.value)}
                rows={3}
                placeholder="比如：三个月内能独立做数据分析"
                className="mt-1.5"
              />
            </label>
            <button
              type="button"
              onClick={submitTrial}
              disabled={trialBusy}
              className="w-full cursor-pointer rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-black/80 disabled:cursor-default disabled:opacity-50"
            >
              {trialBusy ? "提交中…" : "提交申请"}
            </button>
            <p className="text-center text-[11px] text-ink-dim/60">只用于发放体验码，不会群发。</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
