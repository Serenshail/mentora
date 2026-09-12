"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import {
  BookOpen,
  Brain,
  Compass,
  LayoutDashboard,
  GraduationCap,
  Settings2,
} from "lucide-react";
import { FeedbackWidget } from "@/components/feedback-widget";
import { useAuth, useAutoPush } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

const NAV = [
  { href: "/", label: "总览", icon: LayoutDashboard },
  { href: "/learn", label: "学习教练", icon: GraduationCap },
  { href: "/brain", label: "第二大脑", icon: Brain },
  { href: "/read", label: "读书伙伴", icon: BookOpen },
  { href: "/council", label: "人生伙伴", icon: Compass },
  { href: "/settings", label: "设置", icon: Settings2 },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const provider = useAppStore((s) => s.settings.provider);
  const router = useRouter();
  const { user, logout } = useAuth();
  useAutoPush(!!user);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div className="flex min-h-screen w-full">
      {/* 侧边栏 */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-white/80 backdrop-blur-xl md:flex">
        <Link href="/" className="flex items-baseline px-5 pb-5 pt-6">
          <span className="font-brand text-[30px] leading-none text-ink">Mentora</span>
        </Link>

        <div>
          <nav className="space-y-0.5 px-3">
            <p className="px-3.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-dim/60">
              工作台
            </p>
            {NAV.slice(0, 5).map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-[13.5px] tracking-[-0.01em] transition-all duration-150",
                  isActive(href)
                    ? "bg-black/[0.05] font-semibold text-ink"
                    : "font-medium text-ink-dim hover:bg-black/[0.035] hover:text-ink"
                )}
              >
                <Icon className="size-[18px]" strokeWidth={1.75} />
                {label}
              </Link>
            ))}
          </nav>
          <nav className="mx-3 mt-4 space-y-0.5 border-t border-border pt-4">
            <p className="px-3.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-dim/60">
              系统
            </p>
            {NAV.slice(5).map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-[13.5px] tracking-[-0.01em] transition-all duration-150",
                  isActive(href)
                    ? "bg-black/[0.05] font-semibold text-ink"
                    : "font-medium text-ink-dim hover:bg-black/[0.035] hover:text-ink"
                )}
              >
                <Icon className="size-[18px]" strokeWidth={1.75} />
                {label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="mt-auto px-3 pb-4 pt-2">
          <FeedbackWidget />
          {user ? (
            <div className="mt-1 flex items-center gap-2 rounded-xl px-2.5 py-2">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#7c6cff] to-[#22d3ee] text-[11px] font-bold text-white">
                {(user.name || user.email).slice(0, 1).toUpperCase()}
              </div>
              <span className="truncate text-xs text-ink">{user.name || user.email}</span>
              <button
                onClick={async () => {
                  await logout();
                  router.push("/");
                }}
                className="ml-auto text-[11px] text-ink-dim hover:text-ink cursor-pointer"
                title="退出登录"
              >
                退出
              </button>
            </div>
          ) : (
            <button
              onClick={() => router.push("/login")}
              className="mt-1 w-full cursor-pointer rounded-xl border border-accent/35 bg-accent/10 px-3 py-2 text-xs font-medium text-[#b7adff] transition hover:bg-accent/20"
            >
              登录 · 数据跟设备走
            </button>
          )}
          <p className="px-2.5 pt-2 text-[10px] text-ink-dim/50">
            {user ? "已登录 · 数据自动同步" : "数据只在你这台电脑上"}
          </p>
          {provider === "demo" && (
            <Link
              href="/settings"
              className="mt-1 block rounded-lg border border-warn/25 bg-warn/[0.07] px-3.5 py-2.5 text-xs text-warn hover:bg-warn/[0.12] transition"
            >
              正在用演示数据 · 点此接上真模型
            </Link>
          )}
        </div>
      </aside>

      {/* 主区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 移动端顶栏 */}
        <header className="sticky top-0 z-40 flex items-center justify-between border-b border-border bg-white/85 px-4 py-3 backdrop-blur-xl md:hidden">
          <Link href="/" className="flex items-baseline">
            <span className="font-brand text-[22px] leading-none text-ink">Mentora</span>
          </Link>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-7 md:px-10 md:py-10">
          <div key={pathname} className="page-fade">
            {children}
          </div>
        </main>

        {/* 移动端底部导航 */}
        <nav className="sticky bottom-0 z-40 grid grid-cols-6 border-t border-border bg-white/90 backdrop-blur md:hidden">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex flex-col items-center gap-1 py-2.5 text-[10px]",
                isActive(href) ? "font-semibold text-accent" : "text-ink-dim"
              )}
            >
              <Icon className="size-5" />
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
