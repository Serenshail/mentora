"use client";

/* 二级页面固定返回条（UI-04）
 *
 * 问题：站内返回此前是正文里的一个内联小按钮，页面滚动后就被滚走了；设置页甚至
 * 没有返回入口。用户在长页面底部想回上一级只能靠浏览器手势。
 *
 * 规则：
 *  - 页面滚动容器顶部的固定条（sticky），不透明背景 + 足够层级，不遮正文；
 *  - 返回区至少 44px 高、文字可读；
 *  - 有有效站内来源（同源 referrer + 有历史）→ 浏览器回退，保留列表筛选/滚动；
 *    外部深链/直接打开 → 回固定上级，绝不「一退离开产品」；
 *  - 不创建循环历史：回退用 back()，兜底用 replace()。 */

import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { NotesEntry } from "@/components/notes-entry";

/** AppShell 维护的站内路由栈（sessionStorage）：SPA 客户端路由不会更新
 *  document.referrer，用 referrer 判断「来源是否站内」在「列表→详情」这种最常见的
 *  客户端导航里必然失效（P2-7）。路由栈由 app-shell 每次路由变化时维护。 */
export const ROUTE_STACK_KEY = "mentora:route-stack";
/* （曾有一个 LAST_IN_APP_ROUTE_KEY = ROUTE_STACK_KEY 的「兼容旧读取方」别名导出：
 *  全仓库零引用，设置页走的是下方 readLastInAppRoute 函数别名——已删，
 *  免得后来者误以为存在第二种存储 key 或仍在服务的调用方。） */

/** 读当前路由栈（栈顶=当前页）。 */
export function readRouteStack(): string[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = window.sessionStorage.getItem(ROUTE_STACK_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 「进入 X 之前的那一页」：栈里倒数第二个条目；没有就用兜底。 */
export function readPreviousInAppRoute(fallback = "/"): string {
  const stack = readRouteStack();
  const prev = stack.length >= 2 ? stack[stack.length - 2] : null;
  if (prev && prev.startsWith("/") && !prev.startsWith("/login")) return prev;
  return fallback;
}

/** 兼容旧 API 名：语义即 readPreviousInAppRoute。 */
export const readLastInAppRoute = readPreviousInAppRoute;

export function PageBackBar({
  title,
  parentLabel,
  parentHref,
  className,
}: {
  /** 当前页面标题（固定在条上，滚到底也知道自己在哪） */
  title: string;
  /** 上级名称，如「学习教练」「书架」「设置」 */
  parentLabel: string;
  /** 外部深链/无历史时的兜底上级 */
  parentHref: string;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const goBack = () => {
    /* 栈顶是当前页：栈里还有上一层 → 浏览器回退（保留列表筛选/滚动，PRD §5.4）；
     * 深链直开（栈里只有当前页）→ replace 回固定上级，绝不「一退离开产品」。 */
    const stack = readRouteStack();
    const current = typeof window !== "undefined" ? window.location.pathname + window.location.search : pathname;
    const cameFromInApp = stack.length >= 2 && stack[stack.length - 1] === current;
    if (cameFromInApp) {
      router.back();
      return;
    }
    router.replace(parentHref);
  };

  return (
    <div
      className={cn(
        /* 移动端顶部还有一条 52px 的站内 topbar，固定条要停在它下面，不能压住它 */
        "sticky top-[var(--mobile-topbar-h)] z-30 md:top-0",
        "-mx-1 mb-3 flex min-h-[44px] items-center gap-2 border-b border-border bg-bg/95 px-1 backdrop-blur",
        className
      )}
    >
      <button
        type="button"
        onClick={goBack}
        data-testid="page-back"
        className="flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[13.5px] text-ink-dim transition hover:bg-black/[0.04] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        返回
        <span className="text-ink-dim/70">{parentLabel}</span>
      </button>
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{title}</span>
      {(pathname.startsWith("/learn/") || pathname.startsWith("/read/")) && <NotesEntry />}
    </div>
  );
}


