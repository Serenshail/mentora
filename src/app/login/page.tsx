"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Input } from "@/components/ui";
import { useAuth, syncAfterLogin } from "@/lib/auth-client";
import { toast } from "sonner";
import {
  BookOpen, Brain, Compass, GraduationCap,
} from "lucide-react";

/* ============================================================
 * 登录页 —— Mainframe 式全屏视频 hero
 * 视频背景：public/hero.mp4（黏土小人），鼠标横移 scrub；
 * 左侧：模糊引言 → 打字机 → 胶囊按钮 → 四模块轮廓（大介绍）；
 * 右侧：白色登录卡片（认证逻辑与 v6 完全一致）。
 * 降级：触屏设备静音循环播放；视频失败 → 深色渐变；
 *       prefers-reduced-motion → 关闭 scrub 与打字机。
 * ============================================================ */

const VIDEO_SRC = "/hero.mp4";
const TYPE_TEXT = "很高兴你停在这儿。想学的东西，说出来——现在，从哪一门开始？";

/* ---------- 打字机（规格：38ms/字，600ms 延迟，完成前显示闪烁光标） ---------- */
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

/* ---------- 鼠标 scrub 视频（seek 队列防洪，触屏/减弱动态自动降级） ---------- */
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

    if (!finePointer || reduceMotion) {
      if (!reduceMotion) {
        video.loop = true;
        void video.play().catch(() => setVideoOk(false));
      }
      return () => video.removeEventListener("error", onError);
    }

    const SENSITIVITY = 0.8;
    let prevX: number | null = null;
    let targetTime = 0.4; // 首帧避开 t=0 黑场
    let seeking = false;

    const onMeta = () => {
      if (video.duration) video.currentTime = Math.min(0.4, video.duration - 0.05);
    };
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

    video.addEventListener("loadedmetadata", onMeta);
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

/* ---------- 左侧大介绍：四模块轮廓 ---------- */
const MODULES = [
  { icon: GraduationCap, title: "学习教练", desc: "摸清底细再排计划，验收不过不放行" },
  { icon: Brain, title: "第二大脑", desc: "笔记织成网，按遗忘曲线提醒复习" },
  { icon: BookOpen, title: "读书伙伴", desc: "不替你总结，陪你把一本书读深" },
  { icon: Compass, title: "人生伙伴", desc: "12 位说真话的智者，第一句就是判断" },
];

/* ---------- 胶囊按钮（规格：白色 4 号 + 描边 1 号；此处适配登录场景） ---------- */
const pillBase =
  "inline-flex items-center justify-center whitespace-nowrap rounded-full px-4 py-[0.35em] text-[13px] mx-[0.2em] mb-[0.4em] transition-colors duration-200 sm:px-5 sm:text-[15px]";
const pillWhite = `${pillBase} border border-black/10 bg-white text-black hover:bg-black hover:text-white`;
const pillOutline = `${pillBase} border border-white bg-transparent text-white hover:bg-white hover:text-black`;

function LoginInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">(
    params.get("mode") === "register" ? "register" : "login"
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const { videoRef, videoOk } = useScrubVideo();
  const { displayed, done } = useTypewriter(TYPE_TEXT);
  const [pillsIn, setPillsIn] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setPillsIn(true), 400);
    return () => clearTimeout(t);
  }, []);

  const afterAuth = async () => {
    const result = await syncAfterLogin(async (cloudUpdatedAt) => {
      return new Promise((resolve) => {
        toast(
          `云端有你的备份（${new Date(cloudUpdatedAt).toLocaleString("zh-CN")}）。用哪份？`,
          {
            duration: 30000,
            action: {
              label: "用云端",
              onClick: () => resolve("cloud"),
            },
            cancel: {
              label: "用本机并覆盖云端",
              onClick: () => resolve("local"),
            },
            onDismiss: () => resolve("cloud"),
          }
        );
      });
    });
    if (result === "pulled") toast.success("已从云端恢复你的数据");
    else if (result === "pushed") toast.success("本机数据已备份到云端");
    router.push("/");
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (mode === "login") {
        await login(email.trim(), password);
      } else {
        await register(email.trim(), password, name.trim());
      }
      await afterAuth();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "出错了");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#0a0a0b] text-white">
      {/* 底层渐变兜底（视频加载失败时可见） */}
      <div
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 50% at 30% 35%, rgba(91,84,230,0.22) 0%, transparent 60%), radial-gradient(ellipse 90% 90% at 50% 60%, #141416 0%, #0a0a0b 70%)",
        }}
      />
      {/* 全屏视频背景：黏土小人，鼠标横移 scrub */}
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
      {/* 压暗罩：保证左侧文字与下方内容可读，右侧留白让小人露出来 */}
      <div className="pointer-events-none fixed inset-0 z-[1] bg-gradient-to-t from-black/85 via-black/45 to-black/25 lg:bg-gradient-to-r lg:from-black/75 lg:via-black/40 lg:to-black/15" />

      {/* 顶栏（规格式：字标 + 装饰星号 / 右侧下划线链接） */}
      <header className="relative z-10 flex items-center justify-between px-5 py-4 sm:px-8 sm:py-5">
        <Link href="/" className="flex items-center gap-2">
          <span className="font-brand text-[26px] leading-none text-white sm:text-[30px]">Mentora</span>
          <span
            className="select-none text-[22px] leading-none text-white/90"
            style={{ letterSpacing: "-0.02em" }}
            aria-hidden
          >
            ✳︎
          </span>
        </Link>
        <Link
          href="/"
          className="text-[14px] text-white underline underline-offset-4 transition-opacity hover:opacity-60"
        >
          返回首页
        </Link>
      </header>

      {/* 主体：左侧大介绍 / 右侧登录卡片 */}
      <main
        className="relative z-10 mx-auto grid w-full max-w-6xl gap-10 px-5 pb-16 sm:px-8 lg:items-center lg:gap-14 lg:pb-0"
        style={{ minHeight: "calc(100vh - 88px)" }}
      >
        {/* ===== 左：介绍 ===== */}
        <div className="max-w-xl">
          {/* 1. 模糊引言（规格：blur(4px) 两行） */}
          <p
            className="pointer-events-none mb-5 select-none text-white sm:mb-6"
            style={{ fontSize: "clamp(18px, 3.2vw, 24px)", lineHeight: 1.3, filter: "blur(4px)" }}
          >
            嘿，你来了——
            <br />
            这就是 Mentora 的学习系统
          </p>

          {/* 2. 打字机（规格：闪烁光标，完成后消失） */}
          <p
            className="mb-5 text-white sm:mb-6"
            style={{ fontSize: "clamp(18px, 3.2vw, 24px)", lineHeight: 1.35, minHeight: "72px" }}
          >
            {displayed}
            {!done && (
              <span
                className="ml-[2px] inline-block h-[1.1em] w-[2px] bg-white align-middle"
                style={{ animation: "blink 1s step-end infinite" }}
              />
            )}
          </p>

          {/* 3. 胶囊按钮（规格：400ms 后淡入上浮，不等打字完成） */}
          <div
            className="flex flex-wrap gap-y-1"
            style={{
              opacity: pillsIn ? 1 : 0,
              transform: pillsIn ? "none" : "translateY(8px)",
              transition: "opacity 0.4s ease, transform 0.4s ease",
            }}
          >
            <button onClick={() => setMode("register")} className={pillWhite}>
              免费开始
            </button>
            <button onClick={() => setMode("login")} className={pillWhite}>
              我有账号
            </button>
            <Link href="/" className={pillOutline}>
              不注册，先随便看看
            </Link>
          </div>

          {/* 4. 大的轮廓：四模块 */}
          <div className="mt-10 grid gap-x-8 gap-y-4 border-t border-white/15 pt-8 sm:grid-cols-2">
            {MODULES.map((m) => (
              <div key={m.title} className="flex items-start gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/[0.08] text-white">
                  <m.icon className="size-4" strokeWidth={1.75} />
                </div>
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold text-white">{m.title}</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-white/55">{m.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ===== 右：白色登录卡片 ===== */}
        <div className="w-full rounded-3xl border border-black/5 bg-white p-7 text-ink shadow-[0_24px_80px_-24px_rgba(0,0,0,0.65)] sm:p-8 lg:max-w-[400px] lg:justify-self-end">
          {/* 模式切换：分段控件 */}
          <div className="mb-7 grid grid-cols-2 rounded-xl border border-border bg-surface-2 p-1">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`h-9 cursor-pointer rounded-[9px] text-[13.5px] font-medium transition-all duration-150 ${
                  mode === m
                    ? "bg-white text-ink shadow-[0_1px_3px_rgba(0,0,0,0.1)]"
                    : "text-ink-dim hover:text-ink"
                }`}
              >
                {m === "login" ? "登录" : "注册"}
              </button>
            ))}
          </div>

          <h1 className="text-[24px] font-bold tracking-[-0.03em] text-ink">
            {mode === "login" ? "欢迎回来" : "建一个账号"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-dim">
            {mode === "login"
              ? "你的学习计划、笔记和对话都在等你。"
              : "登录后，数据跟着你走——换设备也在。"}
          </p>

          <div className="mt-6 space-y-3">
            {mode === "register" && (
              <Input
                placeholder="怎么称呼你（可选）"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
            <Input
              type="email"
              placeholder="邮箱"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <Input
              type="password"
              placeholder="密码（至少 6 位）"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <Button className="w-full" size="lg" onClick={submit} loading={busy}>
              {mode === "login" ? "登录" : "注册并登录"}
            </Button>
          </div>

          <p className="mt-5 text-center text-xs text-ink-dim">
            {mode === "login" ? (
              <>
                没有账号？{" "}
                <button
                  onClick={() => setMode("register")}
                  className="cursor-pointer font-medium text-accent hover:underline"
                >
                  注册一个
                </button>
              </>
            ) : (
              <>
                已有账号？{" "}
                <button
                  onClick={() => setMode("login")}
                  className="cursor-pointer font-medium text-accent hover:underline"
                >
                  去登录
                </button>
              </>
            )}
          </p>

          <p className="mt-6 border-t border-border pt-5 text-center text-[11px] leading-relaxed text-ink-dim/60">
            密码经单向加密存储，任何人（包括我们）看不到原文。
            <br />
            不想注册？数据照旧存在这台电脑上。
          </p>
        </div>
      </main>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="py-20 text-center text-ink-dim">加载中…</div>}>
      <LoginInner />
    </Suspense>
  );
}
