"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import {
  BookOpen,
  Brain,
  ChevronLeft,
  ChevronRight,
  Compass,
  LayoutDashboard,
  GraduationCap,
  Search,
  Settings2,
  LogOut,
  ShieldCheck,
  Footprints,
} from "lucide-react";
import { CmdK } from "@/components/cmdk";
import { FeedbackWidget } from "@/components/feedback-widget";
import { AssistantWidget } from "@/components/assistant-widget";
import { toast } from "sonner";
import { ErrorBoundary } from "@/components/error-boundary";
import { applyPeriodTheme, periodOf, PERIOD_LABEL } from "@/lib/period";
import { useAuth, useAutoPush, useSyncStatus, useFlushOnHide } from "@/lib/auth-client";
import { isAdminEmail } from "@/lib/admin-emails";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

const NAV = [
  { href: "/", label: "总览", icon: LayoutDashboard },
  { href: "/learn", label: "学习教练", icon: GraduationCap },
  { href: "/brain", label: "第二大脑", icon: Brain },
  { href: "/read", label: "读书伙伴", icon: BookOpen },
  { href: "/council", label: "人生伙伴", icon: Compass },
  { href: "/life", label: "学习人生", icon: Footprints },
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
  useFlushOnHide(!!user); // 关页/切后台前强制 flush,防数据没推上去就丢

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

  /* 全局命令面板（⌘K）：搜索/跳转任意页面、目标、笔记、书籍 */
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdkOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* 移动顶栏的滚动边缘：滚过 8px 才显发丝线 */
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  /* 学习时段主题：按本地时间切换氛围色,每 10 分钟校准一次 */
  const [period, setPeriod] = useState(periodOf);
  useEffect(() => {
    applyPeriodTheme();
    const iv = setInterval(() => {
      applyPeriodTheme();
      setPeriod(periodOf());
    }, 600_000);
    return () => clearInterval(iv);
  }, []);

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
      {/* 侧边栏：Apple 玻璃配方（saturate 180% + blur 20px）——玻璃只用于真正层叠处 */}
      <aside
        className={cn(
          "glass-chrome sticky top-0 relative hidden h-screen shrink-0 flex-col border-r border-border transition-[width] duration-200 [transition-timing-function:var(--ease-spring)] md:flex",
          collapsed ? "w-14" : "w-64"
        )}
      >
        {/* 收起/展开把手：贴右缘外置（Notion/Linear 式）——收起后把手仍悬在屏幕左缘，永远可见可点 */}
        <button
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "展开侧栏" : "收起侧栏"}
          aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
          className="absolute -right-3.5 top-[72px] z-50 grid size-7 cursor-pointer place-items-center rounded-full border border-border bg-surface text-ink-dim shadow-card transition-all duration-200 [transition-timing-function:var(--ease-out-quart)] hover:scale-110 hover:text-ink active:scale-95"
        >
          {collapsed ? (
            <ChevronRight className="size-4" />
          ) : (
            <ChevronLeft className="size-4" />
          )}
        </button>
        {!collapsed ? (
          <div className="flex items-center justify-between px-3 pb-3 pt-5">
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

        {/* 全局搜索入口：收起状态下也能直达任意目录/笔记/目标/书籍（⌘K） */}
        <div className={cn("pb-2", collapsed ? "px-1.5" : "px-3")}>
          <button
            onClick={() => setCmdkOpen(true)}
            title="搜索（Ctrl/Cmd+K）"
            aria-label="搜索（Ctrl/Cmd+K）"
            className={cn(
              "flex cursor-pointer items-center rounded-lg border border-border bg-white/70 text-ink-3 transition hover:border-black/[0.14] hover:text-ink",
              collapsed ? "h-10 justify-center" : "h-9 gap-2 px-3 text-[13px]"
            )}
          >
            <Search className="size-4 shrink-0" />
            {!collapsed && (
              <>
                <span>搜索…</span>
                <kbd className="ml-auto rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] tabular">
                  {isMac ? "⌘K" : "Ctrl K"}
                </kbd>
              </>
            )}
          </button>
        </div>

        <div>
          <nav className={cn("space-y-0.5", collapsed ? "px-1.5" : "px-3")}>
            {!collapsed && (
              <p className="px-3.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-dim/60">
                工作台
              </p>
            )}
            {NAV.slice(0, 6).map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                title={collapsed ? label : undefined}
                aria-label={collapsed ? label : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg text-[13.5px] tracking-[-0.01em] transition-all duration-150",
                  collapsed ? "justify-center px-2 py-3" : "px-3.5 py-2.5",
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
            {NAV.slice(6).map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                title={collapsed ? label : undefined}
                aria-label={collapsed ? label : undefined}
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
                aria-label={collapsed ? "管理后台" : undefined}
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
                <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#1d1d1f] text-[11px] font-bold text-white">
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
                aria-label="退出登录"
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
      <CmdK open={cmdkOpen} onOpenChange={setCmdkOpen} />

      {/* 主区（未登录时全屏渲染：落地页/登录页自带结构） */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 移动端顶栏：玻璃配方 + 滚动边缘（内容滚到下面才显发丝线，顶部时无痕） */}
        <header
          className={cn(
            "glass-chrome sticky top-0 z-40 flex items-center justify-between border-b border-transparent px-4 py-3 transition-[border-color,box-shadow] duration-300 md:hidden",
            scrolled && "scrolled-chrome"
          )}
        >
          <Link href="/" className="flex items-baseline">
            <span className="font-brand text-[22px] leading-none text-ink">Mentora</span>
          </Link>
        </header>

        <main className="flex w-full flex-1 flex-col px-4 py-6 md:px-7 md:py-8">
          <div key={pathname} className="page-fade">
            <ErrorBoundary>{children}</ErrorBoundary>
          </div>
        </main>

        {/* 移动端底部导航（管理员多一个「后台」入口） */}
        <nav
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          className={cn(
            "sticky bottom-0 z-40 grid border-t border-border bg-white/90 backdrop-blur md:hidden",
            isAdmin ? "grid-cols-8" : "grid-cols-7"
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
