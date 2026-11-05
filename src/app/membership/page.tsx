"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, Input, PageHeader } from "@/components/ui";
import { useAuth } from "@/lib/auth-client";
import { PLANS, priceLabel, type PlanId } from "@/lib/pricing";
import { cn } from "@/lib/utils";
import { Check, CreditCard, Mail, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

const TONE: Record<string, "accent" | "bad" | "warn" | "dim"> = {
  active: "accent",
  expiring: "warn",
  expired: "bad",
  legacy: "dim",
};

const LABEL: Record<string, string> = {
  active: "有效中",
  expiring: "即将到期",
  expired: "已到期",
  legacy: "长期有效",
};

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

export default function MembershipPage() {
  const { user, redeem } = useAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const ent = user?.entitlement;
  const status = ent?.status ?? "legacy";
  const plan = ent?.plan && ent.plan in PLANS ? PLANS[ent.plan as PlanId] : null;

  const submit = async () => {
    const c = code.trim();
    if (!c || busy) return;
    setBusy(true);
    try {
      const next = await redeem(c);
      setCode("");
      toast.success(
        next.expiresAt ? `已开通，有效期至 ${fmt(next.expiresAt)}` : "已开通"
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "兑换失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
      <PageHeader
        title="会员"
        desc="一次购买一张激活码，兑换后开始计时；续费时再兑换一张，天数会在原到期日上累加。"
        icon={<CreditCard className="size-5" />}
      />

      {/* 当前状态 */}
      <Card className="mb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="text-lg font-bold text-ink">
                {status === "legacy" ? "长期有效" : plan ? `${plan.name}会员` : "尚未开通"}
              </span>
              <Badge tone={TONE[status] ?? "dim"}>{LABEL[status] ?? status}</Badge>
            </div>
            <p className="mt-2 text-sm text-ink-dim">
              {status === "legacy"
                ? "你的账号没有到期时间，所有功能可用。"
                : status === "expired"
                  ? `已于 ${fmt(ent?.expiresAt)} 到期，已自动转入免费版：AI 按月度额度受限（每月恢复），学习教练限前两个阶段；学习记录、笔记和导出全部保留。续费立刻恢复完整额度。`
                  : `有效期至 ${fmt(ent?.expiresAt)}${
                      typeof ent?.daysLeft === "number" ? `（还剩 ${ent.daysLeft} 天）` : ""
                    }，到期后自动转入免费版，数据不受影响。`}
            </p>
          </div>
          <Link href="/settings">
            <Button variant="outline" size="sm">
              账户设置
            </Button>
          </Link>
        </div>
      </Card>

      {/* 续费 */}
      <Card className="mb-5">
        <p className="text-sm font-bold text-ink">兑换激活码</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-dim">
          买到的卡密长得像 <span className="tabular font-semibold text-ink">MTR-7K2P-9QXE</span>，
          粘贴进来即可。一张码只能用一次。
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input
            className="flex-1 font-mono tracking-wider uppercase"
            placeholder="XXXX-XXXX-XXXX"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            disabled={busy}
          />
          <Button onClick={submit} loading={busy} disabled={!code.trim()}>
            <RefreshCw className="size-4" /> 兑换
          </Button>
        </div>
      </Card>

      {/* 价格 */}
      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        {(["month", "year"] as PlanId[]).map((id) => {
          const p = PLANS[id];
          return (
            <Card key={id} className={cn("relative", id === "year" && "border-accent/40")}>
              {id === "year" && (
                <span className="absolute -top-2.5 left-4 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-white">
                  更划算
                </span>
              )}
              <p className="text-sm font-bold text-ink">{p.name}</p>
              <p className="mt-2 flex items-baseline gap-1">
                <span className="text-3xl font-bold tracking-tight text-ink">¥{priceLabel(p.price)}</span>
                <span className="text-xs text-ink-dim">/ {p.days === 30 ? "月" : "年"}</span>
              </p>
              <p className="mt-2 min-h-[2.5em] text-xs leading-relaxed text-ink-dim">{p.tagline}</p>
              <ul className="mt-2 space-y-1.5 text-xs text-ink-dim">
                <li className="flex items-center gap-1.5"><Check className="size-3.5 text-good" /> 全部功能，无额外限制</li>
                <li className="flex items-center gap-1.5"><Check className="size-3.5 text-good" /> 到期后可继续登录与导出</li>
              </ul>
            </Card>
          );
        })}
      </div>

      {/* 拉新已收进 设置 → 邀请（用户定）：这里只留一行入口，避免两处维护 */}
      <Card className="mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-dim">
            拉一个朋友注册，你可以<b className="text-ink">多一个月</b>——邀请码在{" "}
            <Link href="/settings" className="font-semibold text-accent hover:underline">
              设置 → 邀请
            </Link>{" "}
            里复制。
          </p>
          <Link href="/settings">
            <Button variant="outline" size="sm">
              去邀请
            </Button>
          </Link>
        </div>
      </Card>

      {/* 购买方式 */}
      <Card>
        <div className="flex items-start gap-3">
          <Mail className="mt-0.5 size-5 text-accent" />
          <div className="min-w-0">
            <p className="text-sm font-bold text-ink">怎么买</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-dim">
              目前是人工发放：微信或邮件联系我，转账后我把激活码发给你，立刻可用。
              需要发票或对公付款也可以直接说。
            </p>
            <p className="mt-2 text-sm">
              <a className="font-semibold text-accent hover:underline" href="mailto:hi@mentora.app">
                hi@mentora.app
              </a>
            </p>
            <p className="mt-3 flex items-center gap-1.5 text-[11px] text-ink-dim/70">
              <ShieldCheck className="size-3.5" />
              到期后数据不会删除；换设备登录同一个账号即可恢复。
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
