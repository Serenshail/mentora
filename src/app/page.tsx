"use client";

/* 首页（v22.0 重构）：只有智能体。
 * 原首页的日历/学习进行时/复习/读书/人生伙伴卡片全部下沉到「学习人生」页。
 * 理由：首页是入口不是仪表盘——用户来是为了"问 / 做"，不是为了看统计。 */
import { useAuth } from "@/lib/auth-client";
import { useHydrated } from "@/lib/use-chat";
import { Skeleton } from "@/components/ui";
import Landing from "@/components/landing";
import { AgentHome } from "@/components/agent-home";

export default function Home() {
  const { user, checking } = useAuth();
  /* 认证检查期给骨架屏：与下方 hydrated 门控同一待遇，不再整页纯空白 */
  if (checking) return <Skeleton className="min-h-screen rounded-none" />;
  if (!user) return <Landing />;
  return <AgentPage />;
}

function AgentPage() {
  const hydrated = useHydrated();
  if (!hydrated) return <Skeleton className="h-64 rounded-2xl bg-surface/60" />;
  return <AgentHome />;
}
