"use client";

/* 首页（v22.0 重构）：只有智能体。
 * 原首页的日历/学习进行时/复习/读书/人生伙伴卡片全部下沉到「学习人生」页。
 * 理由：首页是入口不是仪表盘——用户来是为了"问 / 做"，不是为了看统计。 */
import Link from "next/link";
import { useAuth, retryAuthProbe } from "@/lib/auth-client";
import { useHydrated } from "@/lib/use-chat";
import { Button, Skeleton } from "@/components/ui";
import Landing from "@/components/landing";
import { AgentHome } from "@/components/agent-home";

export default function Home() {
  const { user, checking, probeFailed } = useAuth();
  /* 认证检查期给骨架屏：与下方 hydrated 门控同一待遇，不再整页纯空白 */
  if (checking) return <Skeleton className="min-h-screen rounded-none" />;
  if (!user) {
    /* 探测失败 ≠ 确定未登录：慢网/函数冷启动>5s/瞬时 5xx 时，旧实现把已登录用户
     * 静默折叠成游客直接进营销落地页，无错误提示也无重试入口。这里给出明确错误态，
     * 保留「去登录」出口；重试由 retryAuthProbe 重新探测（checking 分支接管转圈）。 */
    if (probeFailed) return <AuthProbeError />;
    return <Landing />;
  }
  return <AgentPage />;
}

/* 认证探测失败的可见错误态（数据无损失：zustand 切仓可逆，重试成功即回到工作台） */
function AuthProbeError() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-base font-bold text-ink">登录状态没检查成功</p>
      <p className="max-w-sm text-sm leading-relaxed text-ink-dim">
        网络刚才不太稳（或服务暂时没响应），没法确认你是否已登录。你的数据都在，不会丢。
        点重试再检查一次；如果你本来就没登录，直接去登录即可。
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={retryAuthProbe}>
          重试
        </Button>
        <Link href="/login">
          <Button size="sm" variant="outline">
            去登录
          </Button>
        </Link>
      </div>
    </div>
  );
}

function AgentPage() {
  const hydrated = useHydrated();
  if (!hydrated) return <Skeleton className="h-64 rounded-2xl bg-surface/60" />;
  return <AgentHome />;
}
