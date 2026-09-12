"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Card, Input } from "@/components/ui";
import { useAuth, syncAfterLogin } from "@/lib/auth-client";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";

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
    <div className="mx-auto max-w-md">
      <div className="mb-8 flex flex-col items-center pt-8 text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-[#7c6cff] to-[#22d3ee]">
          <Sparkles className="size-6 text-white" />
        </div>
        <h1 className="text-2xl font-bold tracking-[-0.03em] text-white">
          {mode === "login" ? "欢迎回来" : "建一个账号"}
        </h1>
        <p className="mt-2 text-sm text-ink-dim">
          登录后，你的学习计划、笔记和对话跟着你走——换设备也在。
        </p>
      </div>

      <Card>
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
          <Button className="w-full" size="lg" onClick={submit} loading={busy}>
            {mode === "login" ? "登录" : "注册并登录"}
          </Button>
        </div>
        <p className="mt-4 text-center text-xs text-ink-dim">
          {mode === "login" ? (
            <>
              没有账号？{" "}
              <button onClick={() => setMode("register")} className="cursor-pointer text-[#22d3ee] hover:underline">
                注册一个
              </button>
            </>
          ) : (
            <>
              已有账号？{" "}
              <button onClick={() => setMode("login")} className="cursor-pointer text-[#22d3ee] hover:underline">
                去登录
              </button>
            </>
          )}
        </p>
      </Card>

      <p className="mt-4 text-center text-[11px] leading-relaxed text-ink-dim/60">
        密码经单向加密存储，任何人（包括我们）看不到原文。
        不想注册？数据照旧存在这台电脑上。
      </p>
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
