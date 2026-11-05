import Link from "next/link";

export const metadata = {
  title: "用户协议 · Mentora",
  description: "使用 Mentora 前请阅读的服务条款。",
};

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-14 leading-relaxed">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">用户协议</h1>
      <p className="mt-2 text-sm text-ink-dim">最近更新：2026-10</p>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-semibold">1. 服务说明</h2>
        <p>
          Mentora 是一个 AI 辅助学习产品（学习教练 / 第二大脑 / 读书伙伴 / 人生伙伴）。
          注册账号后可用云同步；未注册也可离线使用，数据保存在本机。
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-semibold">2. AI 内容免责</h2>
        <p>
          AI 生成的内容（计划、讲解、判分、建议等）可能存在错误，<strong>不构成专业意见</strong>（医疗、法律、投资等请咨询专业人士）。
          验收门判定仅供参考，最终学习效果取决于你的实际练习。
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-semibold">3. 账号与数据</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>你需对账号与密码安全负责；发现盗用请立即重置密码。</li>
          <li>你保留自己内容的全部权利；为提供服务（存储、同步、模型转发），你授予我们处理这些数据的有限许可。</li>
          <li>详细的数据收集与保护方式见 <Link href="/privacy" className="underline underline-offset-4">隐私政策</Link>。</li>
        </ul>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-semibold">4. 使用规范</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>不利用服务生成、传播违法违规内容；不滥用接口（限流与配额约束保留）。</li>
          <li>违反规范可能导致暂停服务与删除账号。</li>
        </ul>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-semibold">5. 服务按「现状」提供</h2>
        <p>
          服务可能因维护、第三方依赖（模型服务商、云服务）中断而暂不可用，我们尽力保障但不承诺不中断。
          免费期间不收取费用；未来如提供付费功能，会提前单独征得同意。
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-semibold">6. 条款变更</h2>
        <p>条款有实质性变更时，将在站内显著位置公告。继续使用即视为接受更新后的条款。</p>
      </section>

      <p className="mt-12 text-sm">
        <Link href="/" className="text-ink-dim underline-offset-4 hover:underline">← 返回首页</Link>
        {" · "}
        <Link href="/privacy" className="text-ink-dim underline-offset-4 hover:underline">隐私政策</Link>
      </p>
    </main>
  );
}