"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn, localDayKey } from "@/lib/utils";
import { isNavigationActive } from "@/lib/navigation";
import { useAppStore, bindStoreSync } from "@/lib/store";
import { parseWorkspace } from "@/lib/workspace";
import {
  ChevronLeft,
  ChevronRight,
  Compass,
  GraduationCap,
  MoreHorizontal,
  Search,
  Settings2,
  LogOut,
  ShieldCheck,
  Footprints,
  Sparkles,
  PanelsTopLeft,
  X,
} from "lucide-react";
import { CmdK } from "@/components/cmdk";
import { BuildBadge } from "@/components/build-badge";
import { FOCUSABLE, Skeleton } from "@/components/ui";
import { FeedbackWidget } from "@/components/feedback-widget";
import { GuideLauncher, OnboardingModal } from "@/components/onboarding-modal";
import { AssistantWidget } from "@/components/assistant-widget";
import { toast } from "sonner";
import { ErrorBoundary } from "@/components/error-boundary";
import { applyPeriodTheme } from "@/lib/period";
import { useAuth, useAutoPush, useSyncStatus, useFlushOnHide, retryCloudSync, downloadLocalBackup, retryAuthProbe } from "@/lib/auth-client";
import { isAdminEmail } from "@/lib/admin-emails";
import { useVisualViewportInset } from "@/lib/use-visual-viewport";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/* 侧栏（v22.0 重构）：首页 = 智能体；学习教练与第二大脑合并为「学习」；
 * 学习人生接管原首页的所有卡片（日历/学习进行时/复习/读书/人生伙伴）。
 * 读书伙伴与人生伙伴保留独立入口（各有结构化工作台）。 */
/* 侧栏（v23.3 重排）：读书伙伴并入「学习」工作台（第二个 tab）；
 * 学习人生紧随 Mentora；人生伙伴回到学习之后。NAV 顺序 = 用户指定终版。 */
/* v24.1（用户定）：设置不再单独占导航位——点击侧栏底部头像/用户框或移动端
 * 「更多」抽屉进入；邀请（拉新）也收进设置页。 */
const NAV = [
  { href: "/", label: "Mentora", icon: Sparkles },
  { href: "/life", label: "成长记录", icon: Footprints },
  { href: "/learn", label: "学习", icon: GraduationCap },
  { href: "/council", label: "人生伙伴", icon: Compass },
];

/* 主工作台容量（PRD-2026-10-26-MOBILE-UI §3.1：5 主入口 +「更多」）。
 * 桌面「工作台」分组、移动底栏主入口共用前 PRIMARY_COUNT 项；溢出项进
 * 桌面「系统」分组与移动「更多」抽屉。 */
const PRIMARY_COUNT = 5;
const PRIMARY_NAV = NAV.slice(0, PRIMARY_COUNT);
const OVERFLOW_NAV = NAV.slice(PRIMARY_COUNT);
const MOBILE_PRIMARY = PRIMARY_NAV;
const MOBILE_MORE = [
  ...OVERFLOW_NAV,
  { href: "/settings", label: "设置", icon: Settings2 },
];

/* 桌面侧栏项：四处复制粘贴的 className 收拢到一处 */
function NavItem({
  href,
  label,
  icon: Icon,
  active,
  collapsed,
}: {
  href: string;
  label: string;
  icon: typeof Sparkles;
  active: boolean;
  collapsed: boolean;
}) {
  return (
    <Link
      href={href}
      data-guide={`nav-${href.slice(1) || "home"}`}
      title={label}
      aria-label={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-lg text-[13.5px] tracking-[-0.01em] transition-all duration-150",
        collapsed ? "justify-center px-2 py-2.5" : "px-3.5 py-2.5",
        active
          ? "bg-black/[0.05] font-semibold text-ink"
          : "font-medium text-ink-dim hover:bg-black/[0.035] hover:text-ink"
      )}
    >
      <Icon className="size-[18px] shrink-0" strokeWidth={1.75} />
      {!collapsed && <span className="min-w-0 truncate">{label}</span>}
    </Link>
  );
}

/* 管理员邮箱（与 /admin 服务端鉴权同一份白名单）；非管理员不显示入口 */

/* 会员到期提示：到期不把人关在门外——只停 AI，笔记与导出照常。
 * 所以这里是一条可关闭前不可忽视的横幅，而不是拦截页。
 * entitlement 由 /api/auth/me 返回，类型直接用 auth-client 的 Entitlement
 * （AuthUser.entitlement 已带类型）：本地再手写一份结构副本，会在 status
 * union（legacy/active/expiring/expired）日后变化时静默漂移且 TS 不报错。 */
function MembershipBanner() {
  const { user } = useAuth();
  const ent = user?.entitlement;
  if (!ent || (ent.status !== "expired" && ent.status !== "expiring")) return null;
  const expired = ent.status === "expired";
  return (
    <Link
      href="/membership"
      className={cn(
        "mb-5 flex items-center gap-2.5 rounded-xl border px-4 py-2.5 text-xs transition",
        expired
          ? "border-bad/25 bg-bad/[0.06] text-bad hover:bg-bad/[0.1]"
          : "border-warn/25 bg-warn/[0.06] text-warn hover:bg-warn/[0.1]"
      )}
    >
      <Sparkles className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {expired
          ? "会员已到期，已转入免费版：AI 按月度免费额度受限，学习记录与笔记全部保留。"
          : `会员还剩 ${ent.daysLeft} 天，到期后自动转入免费版（AI 额度受限，数据不受影响）。`}
      </span>
      <span className="shrink-0 font-semibold underline-offset-2 hover:underline">续费 →</span>
    </Link>
  );
}

/* 新版本提醒（自托管关键 UX）：长驻标签页会一直跑部署时的旧 bundle（移动端
 * 冻结标签页尤其明显——用户看到的永远是旧功能/旧 bug）。/api/health 返回构建
 * sha，轮询发现变化就提示一键刷新。Vercel 上同样受益。 */
function useNewBuildNotifier() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let known: string | null = null;
    let dead = false;
    const check = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const j = (await res.json()) as { build?: string };
        if (!j.build || dead) return;
        if (known === null) {
          known = j.build; // 首次记录当前版本，不提示
        } else if (j.build !== known) {
          setStale(true);
        }
      } catch { /* 离线/失败静默 */ }
    };
    void check();
    const t = setInterval(check, 5 * 60_000);
    return () => { dead = true; clearInterval(t); };
  }, []);
  return stale;
}

/* 定时提醒落地提示：今天已发送的提醒在应用内也露一次面（邮件之外的第二通道）。
 * 按天可关闭：localStorage 记 "rem-banner-<日期>"，当天关掉不再出现。 */
function useReminderBanner() {
  const [items, setItems] = useState<{ id: string; title: string; time: string }[]>([]);
  const [closed, setClosed] = useState(true);
  useEffect(() => {
    const today = localDayKey();
    let dead = false;
    try {
      if (window.localStorage.getItem(`rem-banner-${today}`) === "1") return;
    } catch { /* 隐私模式：照常展示 */ }
    fetch("/api/reminders", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (dead || !j?.reminders) return;
        const fired = (j.reminders as { id: string; title: string; time: string; firedToday?: boolean }[])
          .filter((r) => r.firedToday);
        if (fired.length > 0) { setItems(fired); setClosed(false); }
      })
      .catch(() => {});
    return () => { dead = true; };
  }, []);
  const close = () => {
    const today = localDayKey();
    try { window.localStorage.setItem(`rem-banner-${today}`, "1"); } catch { /* 忽略 */ }
    setClosed(true);
  };
  return { items, closed, close };
}
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const knowledge=useAppStore(s=>s.knowledge);
  const personalPages=useMemo(()=>knowledge.filter(n=>parseWorkspace(n.workspace)),[knowledge]);
  const provider = useAppStore((s) => s.settings.provider);
  const apiKey = useAppStore((s) => s.settings.apiKey);
  const router = useRouter();
  const { user, logout, checking, probeFailed } = useAuth();
  const syncStatus = useSyncStatus((s) => s.status);
  const buildStale = useNewBuildNotifier();
  const reminderBanner = useReminderBanner();
  useAutoPush(!!user);
  useFlushOnHide(!!user && syncStatus !== "conflict"); // 关页/切后台前强制 flush,防数据没推上去就丢

  /* 多标签页同步：学习窗口开在新标签页，计划页回到前台时采用磁盘上的最新进度 */
  useEffect(() => {
    bindStoreSync();
  }, []);

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

  /* 学习时段主题：按本地时间切换氛围色，每 10 分钟校准一次。
   * 主题切换由 applyPeriodTheme 直接写 CSS 变量完成，不经过 React 渲染——
   * 此前的 period state 赋值后从未被读取（PERIOD_LABEL 也全程未用），死状态
   * 误导维护者以为时段主题走 React，还让 AppShell（全站外壳）每 10 分钟白渲染一次。 */
  useEffect(() => {
    applyPeriodTheme();
    const iv = setInterval(applyPeriodTheme, 600_000);
    return () => clearInterval(iv);
  }, []);

  /* 本地填了自己的 Key 且选了厂商 = BYOK 真模型（判定与 client.ts 的 byokHeaders 一致）；
   * 没填时 provider 的默认值 "demo" 语义是"跟随服务端"，得看 /api/health 的 channel.ai。
   * 旧实现直接看本地默认值，把"跟随服务端"当成了演示模式——
   * 于是每个用户侧栏都挂着"正在用演示数据"，而实际走的是服务端真模型。 */
  const byok = Boolean(apiKey && provider && provider !== "demo");
  /* 三态：undefined=探测中，null=探活失败（未知），true/false=演示/真模型。
   * 旧实现把请求失败也折成 false，真演示 + 一次网络抖动 = 整场把演示回声当真模型输出。 */
  const [serverDemo, setServerDemo] = useState<boolean | null | undefined>(undefined);
  useEffect(() => {
    if (byok) return; // 自带 Key：服务端配没配模型都不影响
    let alive = true;
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive) return;
        const ai = j?.channel?.ai;
        setServerDemo(ai === "demo" ? true : ai ? false : null);
      })
      .catch(() => {
        if (alive) setServerDemo(null); // 失败=未知，不与「真模型」混同
      });
    return () => {
      alive = false;
    };
  }, [byok]);
  const demoMode = !byok && serverDemo === true;

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
    /* store 侧的存储告警（旧数据没迁移成功 / 本地快照损坏）：
     * 这些故障以前只在注释里"忽略"，用户侧完全无感，直到发现数据不见了。 */
    const onStoreWarning = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      toast.error(detail || "本地数据读写异常，请到设置页导出备份。");
    };
    window.addEventListener("mentora:quota", onQuota);
    window.addEventListener("mentora:store-warning", onStoreWarning);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("mentora:quota", onQuota);
      window.removeEventListener("mentora:store-warning", onStoreWarning);
      window.removeEventListener("error", onError);
    };
  }, []);

  /* /admin 自带独立密码门，不需要登录态，也不参与登录跳转（否则和登录页互相弹） */
  const isAuthPage = pathname === "/login";
  const isPublicPath = pathname === "/" || isAuthPage || pathname === "/admin" || pathname === "/privacy" || pathname === "/terms";
  useEffect(() => {
    if (!checking && !probeFailed && !user && !isPublicPath) {
      router.replace(`/login?next=${encodeURIComponent(pathname + window.location.search)}`);
    }
  }, [checking, probeFailed, user, isPublicPath, pathname, router]);
  useEffect(() => {
    if (!probeFailed) return;
    window.addEventListener("online", retryAuthProbe);
    return () => window.removeEventListener("online", retryAuthProbe);
  }, [probeFailed]);

  /* 移动「更多」抽屉：只该在已登录的应用内出现 */
  const [moreOpen, setMoreOpen] = useState(false);
  const [guideOpenFor,setGuideOpenFor]=useState<string|null>(null);
  const guideAfterMore = useRef<string | null>(null);
  useEffect(() => {
    // 路由变化即收起：抽屉不能跨页面残留（effect 同步 setState 是 lint 红线，挪一拍）
    const raf = requestAnimationFrame(() => setMoreOpen(false));
    return () => cancelAnimationFrame(raf);
  }, [pathname]);

  /* UI-04：维护站内路由栈（page-back-bar 据此决定 back() 还是 replace 兜底；
   * 设置页「进入设置前的那一页」= 栈里倒数第二个条目）。栈顶=当前页；
   * 检测到回退（新路径 == 栈里上一层）时弹栈，避免 back/前进制造循环历史。 */
  useEffect(() => {
    try {
      const q = typeof window !== "undefined" ? window.location.search : "";
      const current = `${pathname}${q}`;
      const key = "mentora:route-stack";
      const raw = window.sessionStorage.getItem(key);
      const arr = raw ? (JSON.parse(raw) as unknown) : [];
      const stack: string[] = Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
      const top = stack[stack.length - 1];
      if (top === current) return;
      if (stack.length >= 2 && stack[stack.length - 2] === current) stack.pop();
      else stack.push(current);
      window.sessionStorage.setItem(key, JSON.stringify(stack.slice(-25)));
    } catch {
      /* 隐私模式写不进 sessionStorage：返回条退化为 replace 固定上级兜底 */
    }
  }, [pathname]);

  /* Back 先关抽屉再离开页面（M1-3）：pushState 塞一条哨兵记录，popstate 时收抽屉 */
  useEffect(() => {
    if (!user || !moreOpen) return;
    history.pushState({ mentoraMore: true }, "");
    const onPop = () => setMoreOpen(false);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      const guideUser = guideAfterMore.current;
      guideAfterMore.current = null;
      // 抽屉因其它原因（路由跳转/组件卸载）关闭时，把哨兵记录退掉，避免 Back 需按两次
      if (history.state?.mentoraMore) {
        // Finish the drawer's history traversal before the tour navigates to its first target.
        if (guideUser) window.addEventListener("popstate", () => setGuideOpenFor(guideUser), { once: true });
        history.back();
      } else if (guideUser) queueMicrotask(() => setGuideOpenFor(guideUser));
    };
  }, [user, moreOpen]);

  /* 抽屉键盘契约（对齐共享 Modal）：Esc 关闭 + 焦点陷阱（Tab 环回）+ 打开锁 body
   * 滚动 + 关闭后焦点归还「更多」按钮。抽屉声明了 aria-modal="true"，若不做焦点
   * 陷阱，Tab 仍会离开抽屉进入被声称不可达的背景内容——读屏用户被误导。 */
  const drawerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const prev = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMoreOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    drawerRef.current?.focus();
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prev?.focus();
    };
  }, [moreOpen]);

  /* 键盘 inset：挂在壳层一处，全站 fixed 层共享（§4.3） */
  useVisualViewportInset(!!user);

  const isActive = (href: string) => isNavigationActive(pathname, href);

  /* 「更多」是否该亮：当前路由落在抽屉内的任一入口（含管理员后台） */
  const moreActive =
    MOBILE_MORE.some(({ href }) => isActive(href)) || pathname.startsWith("/admin");

  /* 认证探测中：受保护页先渲染骨架，避免先闪一帧内容再跳登录/套壳的布局抖动 */
  if (checking && !isPublicPath) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Skeleton className="h-40 w-full max-w-md rounded-2xl bg-surface/60" />
      </div>
    );
  }
  if (probeFailed && !user && !isPublicPath) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center" role="status">
        <p className="font-medium text-ink">暂时无法确认登录状态</p>
        <p className="text-sm text-ink-dim">连接恢复后可以从当前页面继续。</p>
        <button type="button" onClick={retryAuthProbe} className="min-h-11 cursor-pointer rounded-lg border border-border bg-white px-4 text-sm font-medium transition hover:bg-surface-2 hover:border-faint">重试连接</button>
      </div>
    );
  }

  /* 登录页始终走全屏布局：注册成功的一瞬 user 已写入，但路由还没跳走，
   * 若此时套上应用壳会和登录页双栏叠成三栏（旧实现靠整页空白规避，反而闪屏）。 */
  if (!user || isAuthPage) {
    return (
      <div className="min-h-screen">
        {children}
      </div>
    );
  }


  const isAdmin = isAdminEmail(user.email, process.env.NEXT_PUBLIC_ADMIN_EMAILS);


  return (
    <div className="flex min-h-screen w-full">
      {/* 新版本已发布：长驻标签页还在跑旧 bundle 时提示一键刷新（自托管部署的关键提醒）。
          顶部留白遵循 --safe-top 移动几何契约（globals.css）：viewportFit=cover 时
          刘海屏的 env(safe-area-inset-top) 非零，写死 pt-2 会顶进状态栏/灵动岛。 */}
      {buildStale && (
        <div className="fixed inset-x-0 top-0 z-[60] flex justify-center px-3" style={{ paddingTop: "calc(var(--safe-top) + 8px)" }}>
          <button
            onClick={() => window.location.reload()}
            className="cursor-pointer rounded-full bg-ink px-4 py-1.5 text-[12px] font-medium text-white shadow-lg transition hover:bg-black/80"
          >
            已发布新版本，点此刷新更新
          </button>
        </div>
      )}
      {/* 今日提醒横幅（邮件之外的第二通道；按天可关闭）。
          与新版本提示同处顶部：后者在时按「safe-top + 44px」下移让位（44px=top-11，
          与提示胶囊的几何一致），否则两条 fixed 横幅完全重合、提醒横幅的关闭按钮
          被压在下面点不到。top 同样带上 --safe-top，见上条注释。 */}
      {!reminderBanner.closed && reminderBanner.items.length > 0 && (
        <div
          className="fixed inset-x-0 z-[55] flex justify-center px-3 pt-2"
          style={{ top: buildStale ? "calc(var(--safe-top) + 2.75rem)" : "var(--safe-top)" }}
        >
          <div className="flex max-w-[92vw] items-center gap-3 rounded-full border border-accent/30 bg-white px-4 py-1.5 shadow-lg">
            <span className="truncate text-[12px] text-ink">
              今日提醒：{reminderBanner.items.map((r) => `${r.time} ${r.title}`).join("；")}
            </span>
            <button
              onClick={reminderBanner.close}
              aria-label="关闭提醒横幅"
              className="shrink-0 cursor-pointer rounded-md p-0.5 text-ink-dim transition hover:text-ink"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      )}
      {/* 侧边栏：Apple 玻璃配方（saturate 180% + blur 20px）——玻璃只用于真正层叠处 */}
      <aside
        className={cn(
          "glass-chrome sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-border transition-[width] duration-200 [transition-timing-function:var(--ease-spring)] md:flex",
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
              "flex w-full cursor-pointer items-center rounded-lg border border-border bg-white/70 text-ink-3 transition hover:border-black/[0.14] hover:text-ink",
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
            {PRIMARY_NAV.map(({ href, label, icon: Icon }) => (
              <NavItem key={href} href={href} label={label} icon={Icon} active={isActive(href)} collapsed={collapsed} />
            ))}
            {personalPages.length>0&&<div className="mt-4 border-t border-border pt-3">
              <NavItem href="/workspace" label="我的系统" icon={PanelsTopLeft} active={pathname==="/workspace"} collapsed={collapsed}/>
              <div className="max-h-[36vh] space-y-0.5 overflow-y-auto">{personalPages.filter(n=>n.workspace!.pinned).map(n=><NavItem key={n.id} href={`/workspace/${encodeURIComponent(n.id)}`} label={n.title} icon={PanelsTopLeft} active={pathname===`/workspace/${n.id}`} collapsed={collapsed}/>)}</div>
            </div>}
          </nav>
          {(OVERFLOW_NAV.length > 0 || isAdmin) && (
            <nav className="mx-3 mt-4 space-y-0.5 border-t border-border pt-4">
              <p className="px-3.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-dim/60">
                系统
              </p>
              {OVERFLOW_NAV.map(({ href, label, icon: Icon }) => (
                <NavItem key={href} href={href} label={label} icon={Icon} active={isActive(href)} collapsed={collapsed} />
              ))}
              {isAdmin && (
                <NavItem href="/admin" label="管理后台" icon={ShieldCheck} active={isActive("/admin")} collapsed={collapsed} />
              )}
            </nav>
          )}
        </div>

        <div className={cn("mt-auto pb-4 pt-2", collapsed ? "px-1.5" : "px-3")}>
          {/* 同步状态可见（saving/error 才显示，saved 不复述）：
              自动推送重试耗尽会置 error，此前全仓无人渲染——用户对"数据丢了"毫无征兆。 */}
          {user && (syncStatus === "saving" || syncStatus === "error") && (
            <p
              className={cn(
                "mb-1 px-2.5 text-[10.5px]",
                syncStatus === "error" ? "text-bad" : "text-ink-dim",
                collapsed && "text-center"
              )}
              title={syncStatus === "error" ? "云端同步失败，改动仍在本机，会自动重试" : "正在把改动同步到云端"}
            >
              {collapsed ? (syncStatus === "error" ? "!" : "…") : syncStatus === "saving" ? "正在同步…" : "同步失败，稍后自动重试"}
            </p>
          )}
          <GuideLauncher collapsed={collapsed} onClick={()=>setGuideOpenFor(user.userId)}/>
          {!collapsed && <FeedbackWidget />}
          {user ? (
            <div className="mt-1 flex items-center gap-2 rounded-xl px-2.5 py-2">
              {/* 头像/用户框 = 设置入口（用户定：设置不单独占导航位，点这里进来） */}
              <button
                onClick={() => router.push("/settings")}
                title="设置"
                aria-label="打开设置"
                className={cn(
                  "flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg py-1 text-left transition hover:bg-black/[0.04]",
                  collapsed && "justify-center"
                )}
              >
                {user.avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.avatar}
                    alt={user.name || user.email}
                    className="size-7 shrink-0 rounded-lg border border-border object-cover"
                  />
                ) : (
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-ink text-[11px] font-bold text-white">
                    {(user.name || user.email).slice(0, 1).toUpperCase()}
                  </div>
                )}
                {!collapsed && <span className="truncate text-xs text-ink">{user.name || user.email}</span>}
              </button>
              <button
                onClick={async () => {
                  try {
                    await logout();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "退出登录未在服务端生效");
                  }
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
          {demoMode && !collapsed && (
            <Link
              href="/settings"
              className="mt-1 block rounded-lg border border-warn/25 bg-warn/[0.07] px-3.5 py-2.5 text-xs text-warn hover:bg-warn/[0.12] transition"
            >
              正在用演示数据 · 点此接上真模型
            </Link>
          )}
          {!byok && serverDemo === null && !collapsed && (
            <p className="mt-1 px-2.5 text-[10px] text-ink-dim/50">暂时无法确认服务端模型状态</p>
          )}
        </div>
      </aside>

      <AssistantWidget />
      <CmdK open={cmdkOpen} onOpenChange={setCmdkOpen} />
      <OnboardingModal key={user.userId} userId={user.userId} open={guideOpenFor===user.userId} autoStart={pathname === "/"} onClose={()=>setGuideOpenFor(null)}/>

      {/* 主区（未登录时全屏渲染：落地页/登录页自带结构） */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 移动端顶栏：玻璃配方 + 滚动边缘（内容滚到下面才显发丝线，顶部时无痕） */}
        <header
          style={{ paddingTop: "var(--safe-top)" }}
          className={cn(
            "glass-chrome sticky top-0 z-40 flex min-h-[calc(var(--mobile-topbar-h)+var(--safe-top))] items-center justify-between border-b border-transparent px-4 py-3 transition-[border-color,box-shadow] duration-300 md:hidden",
            scrolled && "scrolled-chrome"
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            {demoMode && (
              /* 演示提示此前只在桌面侧栏：移动端用户全程收不到「正在用演示数据」 */
              <Link
                href="/settings"
                className="shrink-0 rounded-full border border-warn/30 bg-warn/[0.08] px-2 py-0.5 text-[10px] font-medium text-warn"
              >
                演示数据
              </Link>
            )}
            <Link href="/" className="flex items-baseline">
              <span className="font-brand text-[22px] leading-none text-ink">Mentora</span>
            </Link>
          </div>
          <button type="button" onClick={() => setCmdkOpen(true)} aria-label="搜索（Ctrl/Cmd+K）" className="tap-target grid cursor-pointer place-items-center rounded-xl text-ink-dim hover:bg-black/[0.045] hover:text-ink">
            <Search className="size-5" />
          </button>
        </header>

        <main className="reserve-mobile-nav flex w-full flex-1 flex-col px-4 pt-6 md:px-7 md:py-8">
          {(syncStatus === "error" || syncStatus === "conflict") && (
            <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-warn/25 bg-warn/[0.06] px-4 py-3 text-sm text-ink">
              <p className="min-w-0 w-full flex-1 basis-full leading-relaxed sm:basis-60">
                {syncStatus === "conflict" ? "另一台设备已更新云端，改动仍保留在本机。请先下载本机备份，再决定是否从云端恢复。" : "云端同步尚未完成，改动仍保留在本机。"}
              </p>
              {syncStatus === "error" && <button type="button" className="min-h-10 cursor-pointer rounded-lg border border-border bg-white px-3 font-medium" onClick={() => void retryCloudSync()}>重试同步</button>}
              <button type="button" className="min-h-10 cursor-pointer rounded-lg border border-border bg-white px-3 font-medium" onClick={downloadLocalBackup}>下载本机备份</button>
              <Link href="/settings#backup" className="min-h-10 content-center text-accent underline underline-offset-4">查看备份与恢复</Link>
            </div>
          )}
          <MembershipBanner />
          <div key={pathname} className="page-fade">
            <ErrorBoundary>{children}</ErrorBoundary>
          </div>
          <div className="mt-auto pt-6">
            <BuildBadge />
          </div>
        </main>

        {/* 移动端底部导航：全部主入口 +「更多」（管理员入口在更多抽屉内，不再挤占格位）。
            列数由主入口数派生：4 项 NAV => 5 等宽列，「更多」贴右缘，无空列。 */}
        <nav
          style={{
            paddingBottom: "var(--safe-bottom)",
            gridTemplateColumns: `repeat(${MOBILE_PRIMARY.length + 1}, minmax(0, 1fr))`,
          }}
          className="sticky bottom-0 z-40 grid border-t border-border bg-white/90 backdrop-blur md:hidden"
        >
          {MOBILE_PRIMARY.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              data-guide={`nav-${href.slice(1) || "home"}`}
              aria-current={isActive(href) ? "page" : undefined}
              className={cn(
                "flex min-w-0 flex-col items-center justify-center gap-1 py-2 text-[10px] leading-none",
                isActive(href) ? "font-semibold text-accent" : "text-ink-dim"
              )}
            >
              <span className="grid h-7 w-7 place-items-center">
                <Icon className="size-5" />
              </span>
              <span className="w-full truncate px-0.5 text-center">{label}</span>
            </Link>
          ))}
          <button
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-label="更多"
            data-guide="more"
            className={cn(
              "flex min-w-0 cursor-pointer flex-col items-center justify-center gap-1 py-2 text-[10px] leading-none",
              moreActive ? "font-semibold text-accent" : "text-ink-dim"
            )}
          >
            <span className="grid h-7 w-7 place-items-center">
              <MoreHorizontal className="size-5" />
            </span>
            <span className="w-full text-center">更多</span>
          </button>
        </nav>

        {/* 「更多」抽屉：溢出主入口/设置/后台/账号（M1-2）。Back 先关这里再离页。 */}
        {moreOpen && (
          <div className="viewport-overlay fixed inset-0 z-50 flex items-end bg-black/30 backdrop-blur-[2px] md:hidden" onClick={() => setMoreOpen(false)}>
            <div
              ref={drawerRef}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-label="更多"
              style={{ paddingBottom: "calc(var(--safe-bottom) + 12px)" }}
              className="materialize open max-h-full w-full overflow-y-auto overscroll-contain rounded-t-2xl border-t border-border bg-white px-2 pb-2 pt-3 shadow-overlay outline-none"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-faint" />
              <div className="mb-3 border-b border-border pb-2"><GuideLauncher onClick={()=>{guideAfterMore.current=user.userId;setMoreOpen(false);}}/></div>
              {personalPages.length>0&&<div className="mb-3 space-y-1 border-b border-border pb-3"><Link href="/workspace" onClick={()=>setMoreOpen(false)} className="block px-4 py-3 text-sm font-semibold">我的系统</Link>{personalPages.filter(n=>n.workspace!.pinned).map(n=><Link key={n.id} href={`/workspace/${encodeURIComponent(n.id)}`} onClick={()=>setMoreOpen(false)} className="block min-h-11 break-words rounded-lg px-4 py-3 text-sm hover:bg-surface-2">{n.title}</Link>)}</div>}
              <div className="grid grid-cols-3 gap-1.5">
                {MOBILE_MORE.map(({ href, label, icon: Icon }) => (
                  <Link
                    key={href}
                    href={href}
                    /* 先关抽屉：路由跳转前退出哨兵 history 条目，避免 Back 需按两次 */
                    onClick={() => setMoreOpen(false)}
                    className={cn(
                      "flex min-h-[64px] flex-col items-center justify-center gap-1.5 rounded-xl border px-1 py-2 text-xs transition",
                      isActive(href)
                        ? "border-accent/30 bg-accent/[0.08] font-semibold text-accent"
                        : "border-border text-ink-dim hover:bg-black/[0.03] hover:text-ink"
                    )}
                  >
                    <Icon className="size-5" />
                    <span className="w-full truncate px-0.5 text-center">{label}</span>
                  </Link>
                ))}
                {isAdmin && (
                  <Link
                    href="/admin"
                    onClick={() => setMoreOpen(false)}
                    className={cn(
                      "flex min-h-[64px] flex-col items-center justify-center gap-1.5 rounded-xl border px-1 py-2 text-xs transition",
                      pathname.startsWith("/admin")
                        ? "border-accent/30 bg-accent/[0.08] font-semibold text-accent"
                        : "border-border text-ink-dim hover:bg-black/[0.03] hover:text-ink"
                    )}
                  >
                    <ShieldCheck className="size-5" />
                    <span className="text-center">管理后台</span>
                  </Link>
                )}
                <button
                  onClick={async () => {
                    setMoreOpen(false);
                    try {
                      await logout();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "退出登录未在服务端生效");
                    }
                    router.push("/");
                  }}
                  className="flex min-h-[64px] flex-col items-center justify-center gap-1.5 rounded-xl border border-border px-1 py-2 text-xs text-ink-dim transition hover:bg-bad/[0.06] hover:text-bad cursor-pointer"
                >
                  <LogOut className="size-5" />
                  退出登录
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
