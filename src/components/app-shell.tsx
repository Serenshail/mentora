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
  LogOut,
  PanelLeftOpen,
  ShieldCheck,
} from "lucide-react";
import { FeedbackWidget } from "@/components/feedback-widget";
import { AssistantWidget } from "@/components/assistant-widget";
import { toast } from "sonner";
import { useAuth, useAutoPush, useSyncStatus } from "@/lib/auth-client";
import { isAdminEmail } from "@/lib/admin-emails";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

const NAV = [
  { href: "/", label: "总览", icon: LayoutDashboard },
  { href: "/learn", label: "学习教练", icon: GraduationCap },
  { href: "/brain", label: "第二大脑", icon: Brain },
  { href: "/read", label: "读书伙伴", icon: BookOpen },
  { href: "/council", label: "人生伙伴", icon: Compass },
  { href: "/settings", label: "设置", icon: Settings2 },
];

/* 管理员邮箱（与 /admin 服务端鉴权同一份白名单）；非管理员不显示入口 */

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const provider = useAppStore((s) => s.settings.provider);
  const router = useRouter();
  const { user, logout, checking } = useAuth();
  const syncStatus = useSyncStatus((s) => s.status);
  useAutoPush(!!user);

  /* 管理员：侧栏（桌面）与底栏（移动端）都给出后台入口，登上账号就能直达 */
  /* 侧栏可收起（图标条模式），用户自己决定宽窄，选择记住 */
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem("mentora-sidebar-collapsed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("mentora-sidebar-collapsed", collapsed ? "1" : "0");
    } catch {}
  }, [collapsed]);

  /* 本地快照写满（知识库过大）时给一次可见提示：不崩溃、数据以云端为准 */
  useEffect(() => {
    let warned = false;
    const onQuota = () => {
      if (warned) return;
      warned = true;
      toast.warning(
        "本地快照已装满：笔记数量超出浏览器存储上限。数据以云端同步为准，功能不受影响。"
      );
    };
    /* Next 内置 web-vitals 的已知缺陷（reportAllChanges 读 undefined.startTime），
     * 非本应用代码；定向抑制，避免控制台噪音掩盖真实错误。 */
    const onError = (e: ErrorEvent) => {
      const stack = (e.error as Error | undefined)?.stack ?? "";
      if (/startTime/.test(e.message) && /reportAllChanges/.test(stack)) e.preventDefault();
    };
    window.addEventListener("mentora:quota", onQuota);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("mentora:quota", onQuota);
      window.removeEventListener("error", onError);
    };
  }, []);

  /* /admin 自带独立密码门，不需要登录态，也不参与登录跳转（否则和登录页互相弹） */
  const isPublicPath = pathname === "/" || pathname === "/login" || pathname === "/admin";
  useEffect(() => {
    if (!checking && !user && !isPublicPath) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [checking, user, isPublicPath, pathname, router]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  if (!user) {
    return (
      <div className="min-h-screen">
        {children}
      </div>
    );
  }


  const isAdmin = isAdminEmail(user.email, process.env.NEXT_PUBLIC_ADMIN_EMAILS);


  return (
    <div className="flex min-h-screen w-full">
      {/* 侧边栏 */}
      <aside
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-white/80 backdrop-blur-xl transition-[width] duration-200 md:flex",
          collapsed ? "w-14" : "w-64"
        )}
      >
        {!collapsed ? (
          <div className="flex items-center px-3 pb-4 pt-5">
            <Link href="/" className="flex items-baseline px-2">
              <span className="font-brand text-[30px] leading-none text-ink">Mentora</span>
            </Link>
          </div>
        ) : (
          /* 收起态：M 居中，字号压在栏宽（56px）以内不越界 */
          <div className="flex items-center justify-center pb-3 pt-4">
            <Link href="/" className="font-brand text-[18px] leading-none text-ink">
              M
            </Link>
          </div>
        )}

        <div>
          <nav className={cn("space-y-0.5", collapsed ? "px-1.5" : "px-3")}>
            {!collapsed && (
              <p className="px-3.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-dim/60">
                工作台
              </p>
            )}
            {NAV.slice(0, 5).map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                title={collapsed ? label : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg text-[13.5px] tracking-[-0.01em] transition-all duration-150",
                  collapsed ? "justify-center px-2 py-2.5" : "px-3.5 py-2.5",
                  isActive(href)
                    ? "bg-black/[0.05] font-semibold text-ink"
                    : "font-medium text-ink-dim hover:bg-black/[0.035] hover:text-ink"
                )}
              >
                <Icon className="size-[18px] shrink-0" strokeWidth={1.75} />
                {!collapsed && label}
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
                title={collapsed ? label : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg text-[13.5px] tracking-[-0.01em] transition-all duration-150",
                  collapsed ? "justify-center px-2 py-2.5" : "px-3.5 py-2.5",
                  isActive(href)
                    ? "bg-black/[0.05] font-semibold text-ink"
                    : "font-medium text-ink-dim hover:bg-black/[0.035] hover:text-ink"
                )}
              >
                <Icon className="size-[18px] shrink-0" strokeWidth={1.75} />
                {!collapsed && label}
              </Link>
            ))}
            {isAdmin && (
              <Link
                href="/admin"
                title={collapsed ? "管理后台" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg text-[13.5px] tracking-[-0.01em] transition-all duration-150",
                  collapsed ? "justify-center px-2 py-2.5" : "px-3.5 py-2.5",
                  isActive("/admin")
                    ? "bg-black/[0.05] font-semibold text-ink"
                    : "font-medium text-ink-dim hover:bg-black/[0.035] hover:text-ink"
                )}
              >
                <ShieldCheck className="size-[18px] shrink-0" strokeWidth={1.75} />
                {!collapsed && "管理后台"}
              </Link>
            )}
          </nav>
        </div>

        <div className={cn("mt-auto pb-4 pt-2", collapsed ? "px-1.5" : "px-3")}>
          {!collapsed && <FeedbackWidget />}
          {/* 收起/展开：与「退出」同一列、紧贴账号行上方（右对齐），收起态居中 */}
          <button
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? "展开侧栏" : "收起侧栏"}
            className={cn(
              "mb-0.5 mt-1 flex items-center rounded-lg py-1.5 text-ink-dim/70 transition hover:bg-black/[0.05] hover:text-ink cursor-pointer",
              collapsed ? "justify-center px-1.5" : "justify-end px-2.5"
            )}
          >
            <PanelLeftOpen
              className={cn("size-5 transition-transform duration-200", collapsed && "rotate-180")}
            />
          </button>
          {user ? (
            <div className="mt-1 flex items-center gap-2 rounded-xl px-2.5 py-2">
              {user.avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.avatar}
                  alt={user.name || user.email}
                  className="size-7 shrink-0 rounded-lg border border-border object-cover"
                />
              ) : (
                <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#1a1a1a] text-[11px] font-bold text-white">
                  {(user.name || user.email).slice(0, 1).toUpperCase()}
                </div>
              )}
              {!collapsed && <span className="truncate text-xs text-ink">{user.name || user.email}</span>}
              <button
                onClick={async () => {
                  await logout();
                  router.push("/");
                }}
                className={cn("text-[11px] text-ink-dim hover:text-ink cursor-pointer", !collapsed && "ml-auto")}
                title="退出登录"
              >
                {collapsed ? <LogOut className="size-3.5" /> : "退出"}
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
          {!collapsed && (
            <p className="px-2.5 pt-2 text-[10px] text-ink-dim/50">
              {user ? "已登录 · 数据自动同步" : "数据只在你这台电脑上"}
            </p>
          )}
          {provider === "demo" && !collapsed && (
            <Link
              href="/settings"
              className="mt-1 block rounded-lg border border-warn/25 bg-warn/[0.07] px-3.5 py-2.5 text-xs text-warn hover:bg-warn/[0.12] transition"
            >
              正在用演示数据 · 点此接上真模型
            </Link>
          )}
        </div>
      </aside>

      <AssistantWidget />

      {/* 主区（未登录时全屏渲染：落地页/登录页自带结构） */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 移动端顶栏 */}
        <header className="sticky top-0 z-40 flex items-center justify-between border-b border-border bg-white/85 px-4 py-3 backdrop-blur-xl md:hidden">
          <Link href="/" className="flex items-baseline">
            <span className="font-brand text-[22px] leading-none text-ink">Mentora</span>
          </Link>
        </header>

        <main className="w-full flex-1 px-4 py-6 md:px-7 md:py-8">
          <div key={pathname} className="page-fade">
            {children}
          </div>
        </main>

        {/* 移动端底部导航（管理员多一个「后台」入口） */}
        <nav
          className={cn(
            "sticky bottom-0 z-40 grid border-t border-border bg-white/90 backdrop-blur md:hidden",
            isAdmin ? "grid-cols-7" : "grid-cols-6"
          )}
        >
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
          {isAdmin && (
            <Link
              href="/admin"
              className={cn(
                "flex flex-col items-center gap-1 py-2.5 text-[10px]",
                isActive("/admin") ? "font-semibold text-accent" : "text-ink-dim"
              )}
            >
              <ShieldCheck className="size-5" />
              后台
            </Link>
          )}
        </nav>
      </div>
    </div>
  );
}
