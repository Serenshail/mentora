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
  Sparkles,
} from "lucide-react";
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

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div className="flex min-h-screen w-full">
      {/* 侧边栏 */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-white/[0.06] bg-surface/30 backdrop-blur-xl md:flex">
        <div className="flex items-center gap-2.5 px-5 py-6">
          <div className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#7c6cff] to-[#22d3ee] shadow-[0_4px_16px_-2px_rgba(124,108,255,0.6)]">
            <Sparkles className="size-5 text-white" />
          </div>
          <div>
            <p className="text-[15px] font-extrabold tracking-[-0.02em] text-white">Mentora</p>
            <p className="text-[10px] text-ink-dim/70">学习 · 认知 · 伙伴</p>
          </div>
        </div>

        <div>
          <nav className="space-y-1 px-3">
            <p className="px-3.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-dim/50">
              工作台
            </p>
            {NAV.slice(0, 5).map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[13.5px] font-medium tracking-[-0.01em] transition-all duration-150",
                  isActive(href)
                    ? "bg-gradient-to-r from-accent/20 to-accent/5 text-white border border-accent/25 shadow-[0_0_20px_-8px_rgba(124,108,255,0.6)]"
                    : "text-ink-dim hover:bg-white/[0.04] hover:text-ink border border-transparent"
                )}
              >
                <Icon className="size-[18px]" strokeWidth={1.75} />
                {label}
              </Link>
            ))}
          </nav>
          <nav className="mt-5 space-y-1 px-3 pt-4 border-t border-white/[0.05]">
            <p className="px-3.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-dim/50">
              系统
            </p>
            {NAV.slice(5).map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[13.5px] font-medium tracking-[-0.01em] transition-all duration-150",
                  isActive(href)
                    ? "bg-gradient-to-r from-accent/20 to-accent/5 text-white border border-accent/25"
                    : "text-ink-dim hover:bg-white/[0.04] hover:text-ink border border-transparent"
                )}
              >
                <Icon className="size-[18px]" strokeWidth={1.75} />
                {label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="px-5 pb-4 pt-2">
          <p className="text-[10px] text-ink-dim/40">Mentora v3.2 · 数据仅存本机</p>
          {provider === "demo" && (
            <Link
              href="/settings"
              className="block rounded-xl border border-warn/30 bg-warn/10 px-3.5 py-2.5 text-xs text-warn/90 hover:bg-warn/15 transition"
            >
              ⚡ 演示模式运行中 — 点此连接真实模型
            </Link>
          )}
        </div>
      </aside>

      {/* 主区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 移动端顶栏 */}
        <header className="sticky top-0 z-40 flex items-center justify-between border-b border-white/[0.06] bg-bg/80 px-4 py-3 backdrop-blur-xl md:hidden">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-[#7c6cff] to-[#22d3ee]">
              <Sparkles className="size-4 text-white" />
            </div>
            <span className="font-bold text-white">Mentora</span>
          </Link>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-7 md:px-10 md:py-10">
          <div key={pathname} className="page-fade">
            {children}
          </div>
        </main>

        {/* 移动端底部导航 */}
        <nav className="sticky bottom-0 z-40 grid grid-cols-6 border-t border-border bg-bg/90 backdrop-blur md:hidden">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex flex-col items-center gap-1 py-2.5 text-[10px]",
                isActive(href) ? "text-[#b7adff]" : "text-ink-dim"
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
