"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Card, Input } from "@/components/ui";
import { useAuth, syncAfterLogin } from "@/lib/auth-client";
import { usePopText } from "@/lib/use-poptext";
import { toast } from "sonner";

/* 登录后回跳目标：只认站内路径，避免 ?next= 被拿去跳外站 */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

/* 左侧品牌轮廓：大字标（PopText）+ 卖点提纲 */
function BrandPanel() {
  const { elRef } = usePopText("Mentora", 300);

  return (
    <aside className="relative hidden flex-col justify-between overflow-hidden bg-ink p-10 text-white md:flex lg:p-14">
      {/* 巨大的手写体水印 */}
      <span
        aria-hidden
        className="font-brand pointer-events-none absolute -bottom-14 -right-8 select-none text-[340px] leading-none text-white/[0.04]"
      >
        M
      </span>

      <div className="relative">
        <h1
          ref={elRef}
          className="pop-text min-h-[1.4em] leading-none"
          style={{ fontFamily: "'Great Vibes', cursive", fontSize: "clamp(56px, 5vw, 76px)" }}
        />
      </div>

      <div className="relative max-w-md">
        <p
          className="font-heading text-[clamp(26px, 2.6vw, 38px)] font-medium leading-[1.25] tracking-[-0.01em]"
        >
          把「学会任何东西」
          <br />
          变成日常。
        </p>

        <ul className="mt-10 space-y-5">
          {[
            { n: "01", t: "教练排计划，每天一课，验收通过才放行" },
            { n: "02", t: "笔记自动织成网，按遗忘曲线提醒复习" },
            { n: "03", t: "12 位人生伙伴，焦虑和决策都有人说真话" },
          ].map((item) => (
            <li key={item.n} className="flex items-baseline gap-4">
              <span className="tabular text-xs font-semibold text-white/40">{item.n}</span>
              <span className="font-body-display text-[15px] leading-relaxed text-white/75">{item.t}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="relative text-xs leading-relaxed text-white/35">
        密码单向加密存储 · 数据随时可导出带走
        <br />
        <span className="font-brand mr-1 text-[15px] text-white/60">Mentora</span>✳︎ 学习教练 ×
        第二大脑 × 读书伙伴 × 人生伙伴
      </p>
    </aside>
  );
}

function LoginInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, checking, login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">(
    params.get("mode") === "register" ? "register" : "login"
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [codeCooldown, setCodeCooldown] = useState(0);
  const [codeBusy, setCodeBusy] = useState(false);

  /* 验证码 60s 倒计时 */
  useEffect(() => {
    if (codeCooldown <= 0) return;
    const t = setTimeout(() => setCodeCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [codeCooldown]);

  /* 已登录还访问 /login：直接回目标页，不渲染登录表单（否则出现三栏叠层） */
  useEffect(() => {
    if (!checking && user) {
      router.replace(safeNext(params.get("next")));
    }
  }, [checking, user, router, params]);

  if (user) {
    return <div className="min-h-screen bg-bg" />;
  }

  const afterAuth = async () => {
    // 全自动同步：云端有数据直接采用，无需用户点选
    const result = await syncAfterLogin();
    if (result === "pulled") toast.success("已同步云端最新数据");
    else if (result === "pushed") toast.success("本机数据已备份到云端");
    // 从 /admin 等页面被送来的，登录完要回到那里，别一律甩回首页
    router.push(safeNext(params.get("next")));
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (mode === "login") {
        await login(email.trim(), password);
      } else {
        await register(email.trim(), password, name.trim(), code.trim());
      }
      await afterAuth();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "出错了");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen md:grid-cols-[1.1fr_1fr]">
      <BrandPanel />

      {/* 右侧：登录表单 */}
      <div className="flex items-center justify-center px-4 py-12 md:px-10">
        <div className="w-full max-w-sm">
          {/* 移动端字标 */}
          <Link href="/" className="mb-8 flex items-baseline justify-center gap-2 md:hidden">
            <span className="font-brand text-[36px] leading-none text-ink">Mentora</span>
            <span className="text-[28px] leading-none text-ink">✳︎</span>
          </Link>

          <h2 className="font-heading text-2xl font-bold tracking-[-0.03em] text-ink">
            {mode === "login" ? "欢迎回来" : "建一个账号"}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-dim">
            登录后，你的学习计划、笔记和对话跟着你走——换设备也在。
          </p>

          <Card className="mt-6">
            <div className="space-y-3">
              {mode === "register" && (
                <Input placeholder="怎么称呼你（可选）" value={name} onChange={(e) => setName(e.target.value)} />
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
              {mode === "register" && (
                <div>
                  <div className="flex gap-2">
                    <Input
                      placeholder="邮箱验证码"
                      inputMode="numeric"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                      onKeyDown={(e) => e.key === "Enter" && submit()}
                    />
                    <Button
                      variant="outline"
                      className="shrink-0"
                      disabled={codeCooldown > 0 || codeBusy}
                      loading={codeBusy}
                      onClick={async () => {
                        if (codeBusy || codeCooldown > 0) return;
                        const em = email.trim();
                        if (!em) {
                          toast.error("先填邮箱再获取验证码");
                          return;
                        }
                        setCodeBusy(true);
                        try {
                          const res = await fetch("/api/auth/send-code", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ email: em }),
                          });
                          const j = await res.json().catch(() => ({}));
                          if (!res.ok) throw new Error(j.error || "发送失败");
                          if (j.devCode) {
                            setCode(String(j.devCode));
                            toast("开发模式：验证码已自动填入（线上需配置发信服务）");
                          } else {
                            toast.success("验证码已发送到你的邮箱，10 分钟内有效");
                          }
                          setCodeCooldown(60);
                        } catch (e2) {
                          toast.error(e2 instanceof Error ? e2.message : "发送失败");
                        } finally {
                          setCodeBusy(false);
                        }
                      }}
                    >
                      {codeCooldown > 0 ? `${codeCooldown}s` : "获取验证码"}
                    </Button>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-ink-dim/70">
                    验证码用于确认这个邮箱真的是你的——收不到请检查垃圾箱。
                  </p>
                </div>
              )}
              <Button className="w-full" size="lg" onClick={submit} loading={busy}>
                {mode === "login" ? "登录" : "注册并登录"}
              </Button>
            </div>
            <p className="mt-4 text-center text-xs text-ink-dim">
              {mode === "login" ? (
                <>
                  没有账号？{" "}
                  <button onClick={() => setMode("register")} className="cursor-pointer text-accent hover:underline">
                    注册一个
                  </button>
                </>
              ) : (
                <>
                  已有账号？{" "}
                  <button onClick={() => setMode("login")} className="cursor-pointer text-accent hover:underline">
                    去登录
                  </button>
                </>
              )}
            </p>
          </Card>

          <p className="mt-5 text-center text-[11px] leading-relaxed text-ink-dim/60">
            密码经单向加密存储，任何人（包括我们）看不到原文。
            <br />
            不想注册？数据照旧存在这台电脑上。
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bg" />}>
      <LoginInner />
    </Suspense>
  );
}
