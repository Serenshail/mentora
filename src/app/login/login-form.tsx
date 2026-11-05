"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, Input } from "@/components/ui";
import { useAuth, syncAfterLogin } from "@/lib/auth-client";
import { usePopText } from "@/lib/use-poptext";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export type LoginMode = "login" | "register" | "reset";

/* 登录后回跳目标：只认站内路径。反斜杠变体也要拦——WHATWG 把 /\evil.com 解析成 //evil.com */
function safeNext(raw: string | null): string {
  return raw && /^\/[^/\\]/.test(raw) ? raw : "/";
}

/* 条件字段展开/收起：grid 0fr→1fr 过渡高度，避免切模式时卡片突然长高/塌陷 */
function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      )}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/* 左侧品牌轮廓：大字标（PopText）+ 卖点提纲 */
function BrandPanel() {
  const { elRef, failed } = usePopText("Mentora", 300);

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
          className="pop-text font-brand min-h-[1.4em] leading-none"
          style={{ fontSize: "clamp(56px, 5vw, 76px)" }}
        >
          {/* PopText 加载失败时的纯文本兜底（成功路径无此节点，视觉不变） */}
          {failed && "Mentora"}
        </h1>
      </div>

      <div className="relative max-w-md">
        <p className="font-heading text-[clamp(26px, 2.6vw, 38px)] font-medium leading-[1.25] tracking-[-0.01em]">
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

export function LoginForm({
  initialMode,
  nextPath,
}: {
  initialMode: LoginMode;
  nextPath: string | null;
}) {
  const router = useRouter();
  const { user, checking, login, register } = useAuth();
  const [mode, setMode] = useState<LoginMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState("");
  const [refCode, setRefCode] = useState("");

  /* 邀请链接（?ref=XXXX）带进来的邀请人码：预填好，用户可以改或清空 */
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("ref");
    if (!fromUrl) return;
    // 挪一拍：effect 同步 setState 是级联渲染红线（lint）
    const raf = requestAnimationFrame(() => {
      setRefCode(fromUrl.toUpperCase().replace(/[^0-9A-Z]/g, ""));
      setMode("register");
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  /* 已登录还访问 /login：直接回目标页。提交中不抢跳转，交给 afterAuth 同步完再走，
   * 否则注册/登录成功瞬间会和整页空白、双重导航叠在一起，看起来就是闪一下。 */
  useEffect(() => {
    if (!checking && user && !busy) {
      router.replace(safeNext(nextPath));
    }
  }, [checking, user, busy, nextPath, router]);

  const afterAuth = async () => {
    // 全自动同步：云端有数据直接采用，无需用户点选。
    // 5s 超时兜底：同步链路挂起时不能把 busy/表单永久锁死（useAuth 探测同款先例）
    const result = await Promise.race([
      syncAfterLogin(),
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ]);
    if (result === "pulled") toast.success("已同步云端最新数据");
    else if (result === "pushed") toast.success("本机数据已备份到云端");
    // 从 /admin 等页面被送来的，登录完要回到那里，别一律甩回首页
    router.push(safeNext(nextPath));
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (mode === "reset") {
        // 忘记密码：邮箱 + 管理员发放的一次性重置码 + 新密码；成功后回登录态，不自动签发会话
        const res = await fetch("/api/auth/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim(), resetCode: invite.trim(), newPassword: password }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || "重置失败");
        toast.success("密码已重置，用新密码登录吧（其他设备需重新登录）");
        setMode("login");
        setPassword("");
        setInvite("");
      } else if (mode === "login") {
        await login(email.trim(), password);
        await afterAuth();
      } else {
        const u = await register(email.trim(), password, name.trim(), invite.trim(), refCode.trim());
        const exp = u.entitlement?.expiresAt;
        toast.success(
          exp ? `开通成功，有效期至 ${new Date(exp).toLocaleDateString("zh-CN")}` : "账号已创建"
        );
        await afterAuth();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "出错了");
    } finally {
      setBusy(false);
    }
  };

  /* 提交中忽略切换；进重置页清空密码，避免把登录密码当新密码直接提交 */
  const switchMode = (next: LoginMode) => {
    if (busy) return;
    if (next === "reset") setPassword("");
    setMode(next);
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
            {mode === "login" ? "欢迎回来" : mode === "reset" ? "重置密码" : "建一个账号"}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-dim">
            {mode === "reset"
              ? "输入邮箱、管理员发给你的重置码和新密码。改完后其他设备都要重新登录。"
              : "登录后，你的学习计划、笔记和对话跟着你走——换设备也在。"}
          </p>

          <Card className="mt-6">
            <div className="flex flex-col">
              <Collapse open={mode === "register"}>
                <Input
                  className="mb-3"
                  placeholder="怎么称呼你（可选）"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                />
              </Collapse>
              <Input
                type="email"
                placeholder="邮箱"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                disabled={busy}
              />
              <Input
                type="password"
                className="mt-3"
                placeholder={mode === "login" ? "密码（至少 6 位）" : "新密码（至少 6 位）"}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                disabled={busy}
              />
              <Collapse open={mode !== "login"}>
                <div className="mt-3">
                  <Input
                    placeholder={mode === "register" ? "激活码（必填）" : "重置码（必填）"}
                    value={invite}
                    onChange={(e) => setInvite(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                    disabled={busy}
                  />
                  <p className="mt-1.5 text-[11px] leading-relaxed text-ink-dim/70">
                    {mode === "register"
                      ? "一张激活码开一个账号，兑换后从当天开始计时。没有码可以先在首页申请 7 天体验。"
                      : "重置码由管理员一次性发放，24 小时内有效。没有的话请联系发码的人。"}
                  </p>
                </div>
              </Collapse>
              <Collapse open={mode === "register"}>
                <div className="mt-3">
                  <Input
                    placeholder="邀请人码（可选）"
                    value={refCode}
                    onChange={(e) => setRefCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                    disabled={busy}
                  />
                  <p className="mt-1.5 text-[11px] leading-relaxed text-ink-dim/70">
                    朋友分享给你的码，填上他那边会多一个月；不填也一样能注册。
                  </p>
                </div>
              </Collapse>
              <Button className="mt-3 w-full" size="lg" onClick={submit} loading={busy}>
                {mode === "login" ? "登录" : mode === "reset" ? "重置密码" : "注册并登录"}
              </Button>
            </div>
            <p className="mt-4 text-center text-xs text-ink-dim">
              {mode === "login" ? (
                <>
                  没有账号？{" "}
                  <button
                    onClick={() => switchMode("register")}
                    disabled={busy}
                    className="cursor-pointer text-accent hover:underline disabled:cursor-default disabled:opacity-50"
                  >
                    注册一个
                  </button>
                  {" · "}
                  <button
                    onClick={() => switchMode("reset")}
                    disabled={busy}
                    className="cursor-pointer text-accent hover:underline disabled:cursor-default disabled:opacity-50"
                  >
                    忘记密码？
                  </button>
                </>
              ) : (
                <>
                  已有账号？{" "}
                  <button
                    onClick={() => switchMode("login")}
                    disabled={busy}
                    className="cursor-pointer text-accent hover:underline disabled:cursor-default disabled:opacity-50"
                  >
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
            <br />
            <Link href="/privacy" className="underline-offset-2 hover:underline">隐私政策</Link>
            {" · "}
            <Link href="/terms" className="underline-offset-2 hover:underline">用户协议</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
