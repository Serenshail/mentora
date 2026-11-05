/* 定价与套餐的唯一真源：首页、会员中心、后台生成卡密都读这里。
 * 改价格只改这一个文件——不要在页面里写死数字。 */

export type PlanId = "trial" | "month" | "year" | "founder";

export interface PlanInfo {
  id: PlanId;
  /** 展示名 */
  name: string;
  /** 天数：兑换后累加到到期时间 */
  days: number;
  /** 售价（元）；0 表示不单独售卖 */
  price: number;
  /** 一句话卖点 */
  tagline: string;
}

export const PLANS: Record<PlanId, PlanInfo> = {
  trial: {
    id: "trial",
    name: "体验",
    days: 7,
    price: 0,
    tagline: "先试一周，再决定要不要留下",
  },
  month: {
    id: "month",
    name: "月度",
    days: 30,
    price: 9.9,
    tagline: "一杯咖啡的钱，换一个月有人盯着你学",
  },
  year: {
    id: "year",
    name: "年度",
    days: 365,
    price: 99,
    tagline: "折合每月 8.3 元，比月付省两杯咖啡",
  },
  founder: {
    id: "founder",
    name: "创始会员",
    days: 3650,
    price: 0,
    tagline: "早期支持者，长期有效",
  },
};

export const PLAN_ORDER: PlanId[] = ["trial", "month", "year", "founder"];

export function planOf(id: string | undefined | null): PlanInfo | null {
  return id && id in PLANS ? PLANS[id as PlanId] : null;
}

/** 页面展示用：9.9 → "9.9"，99 → "99" */
export function priceLabel(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/* ---- 拉新奖励（用户 2026-11-05 定：拉一个新用户送一个月） ----
 * 这里只放纯常量：本文件同时被浏览器端引用，不能在模块顶层读 process.env。 */
export const REFERRAL = {
  /** 邀请人每成功拉到一个新注册用户，加多少天 */
  rewardDays: 30,
  /** 计入的套餐名（会员页展示用） */
  rewardPlan: "month" as PlanId,
  /** 每个邀请人 30 天内最多拿几次奖励（防刷）；服务端可用 REFERRAL_MONTHLY_CAP 覆盖 */
  monthlyCap: 10,
};
