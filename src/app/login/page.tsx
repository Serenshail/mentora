"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Input } from "@/components/ui";
import { useAuth, syncAfterLogin } from "@/lib/auth-client";
import { toast } from "sonner";
import {
  BookOpen, Brain, Compass, GraduationCap, ArrowLeft,
} from "lucide-react";

/* ============================================================
 * 登录页 —— 左叙事 / 右表单 分屏
 * 左侧：深色品牌面板（PopText 交互字标 + 四大模块轮廓）
 * 右侧：浅色表单区（认证逻辑保持不变）
 * ============================================================ */

/* ---------- PopText 资产按需加载（左屏字标彩蛋） ---------- */
function usePopText(text: string, delay = 0) {
  const elRef = useRef<HTMLHeadingElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!document.querySelector('link[data-poptext-css]')) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "/poptext/pop-text.css";
        link.setAttribute("data-poptext-css", "1");
        document.head.appendChild(link);
      }
      if (!document.querySelector('link[data-popfont]')) {
        const font = document.createElement("link");
        font.rel = "stylesheet";
        font.href = "https://fonts.googleapis.com/css2?family=Great+Vibes&display=swap";
        font.setAttribute("data-popfont", "1");
        document.head.appendChild(font);
      }
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
      PT.arm(elRef.current);
      await PT.type(elRef.current, text, { step: 95, startDelay: delay, cursor: true });
      if (!cancelled) setReady(true);
    };
    void load();
    return () => { cancelled = true; };
  }, [text, delay]);

  return { elRef, ready };
}

/* ---------- 左屏：品牌叙事面板 ---------- */
const MODULES = [
  { icon: GraduationCap, title: "学习教练", desc: "摸清底细再排计划，验收不过不放行" },
  { icon: Brain, title: "第二大脑", desc: "笔记自己织成网，按遗忘曲线提醒你复习" },
  { icon: BookOpen, title: "读书伙伴", desc: "不替你总结，陪你把一本书读深" },
  { icon: Compass, title: "人生伙伴", desc: "12 位说真话的智者，第一句就是判断" },
];

function BrandPanel() {
  const { elRef, ready } = usePopText("Mentora", 400);

  return (
    <div
      className="relative hidden flex-col justify-between overflow-hidden p-10 lg:flex xl:p-14"
      style={{
        background:
          "radial-gradient(ellipse 70% 50% at 25% 20%, rgba(91,84,230,0.28) 0%, transparent 60%), radial-gradient(ellipse 60% 60% at 85% 90%, rgba(14,116,144,0.22) 0%, transparent 55%), linear-gradient(160deg, #131315 0%, #0a0a0b 70%)",
      }}
    >
      {/* 细网格纹理 */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      />

      {/* 顶部：字标彩蛋 */}
      <div className="relative">
        <h1
          ref={elRef}
          className="pop-text min-h-[1.3em] leading-none"
          style={{
            fontFamily: "'Great Vibes', cursive",
            fontSize: "min(88px, 7vw)",
            color: "#fff",
          }}
        />
        {ready && (
          <p className="mt-3 text-[11px] tracking-[0.15em] text-white/30">
            ↑ 鼠标划过字母试试
          </p>
        )}
      </div>

      {/* 中部：主张 + 模块轮廓 */}
      <div className="relative mt-6">
        <p className="max-w-md text-[22px] leading-snug tracking-[-0.01em] text-white xl:text-[26px]">
          一个把「学会任何东西」
          <br />
          变成日常的系统。
        </p>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-white/50">
          教练排计划、盯验收，笔记自己织成网，读书有人陪，困惑有人跟你说真话。
        </p>

        <div className="mt-10 space-y-1 border-t border-white/10">
          {MODULES.map((m) => (
            <div
              key={m.title}
              className="group flex items-center gap-4 border-b border-white/10 py-4 transition-colors"
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/15 bg-white/[0.05] text-white/80 transition-colors group-hover:border-white/30 group-hover:text-white">
                <m.icon className="size-[18px]" strokeWidth={1.75} />
              </div>
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-white">{m.title}</p>
                <p className="truncate text-[12.5px] text-white/45">{m.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 底部：态度 */}
      <p className="relative mt-8 text-[13px] leading-relaxed text-white/40">
        「它不负责哄你开心，负责让你变清醒。」
      </p>
    </div>
  );
}

/* ---------- 右屏：表单 ---------- */
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
    <div className="flex min-h-screen bg-[#0a0a0b] lg:grid lg:grid-cols-[1.05fr_1fr]">
      <BrandPanel />

      {/* 右屏：浅色表单区 */}
      <div className="relative flex flex-1 flex-col bg-[#fafafa] lg:rounded-l-[28px] lg:shadow-[-24px_0_60px_-30px_rgba(0,0,0,0.5)]">
        {/* 顶条 */}
        <div className="flex items-center justify-between px-5 py-4 sm:px-8">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-[13px] text-ink-dim transition-colors hover:text-ink"
          >
            <ArrowLeft className="size-4" /> 返回首页
          </Link>
          {/* 移动端补一个品牌字标（左屏被隐藏时） */}
          <span className="font-brand text-[24px] leading-none text-ink lg:hidden">Mentora</span>
        </div>

        <div className="flex flex-1 items-center justify-center px-5 pb-16 sm:px-8">
          <div className="w-full max-w-[400px]">
            {/* 移动端的一句话介绍 */}
            <p className="mb-8 text-center text-[13px] leading-relaxed text-ink-dim lg:hidden">
              学习教练 × 第二大脑 × 读书伙伴 × 人生伙伴
            </p>

            {/* 模式切换：分段控件 */}
            <div className="mb-8 grid grid-cols-2 rounded-xl border border-border bg-surface-2 p-1">
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

            <h1 className="text-[26px] font-bold tracking-[-0.03em] text-ink">
              {mode === "login" ? "欢迎回来" : "建一个账号"}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-dim">
              {mode === "login"
                ? "你的学习计划、笔记和对话都在等你。"
                : "登录后，数据跟着你走——换设备也在。"}
            </p>

            <div className="mt-7 space-y-3">
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

            <p className="mt-8 border-t border-border pt-5 text-center text-[11px] leading-relaxed text-ink-dim/60">
              密码经单向加密存储，任何人（包括我们）看不到原文。
              <br />
              不想注册？数据照旧存在这台电脑上。
            </p>
          </div>
        </div>
      </div>
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
