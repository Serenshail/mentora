import Link from "next/link";

export const metadata = {
  title: "隐私政策 · Mentora",
  description: "Mentora 收集哪些数据、如何保护与如何删除。",
};

/* 静态法务页：无登录墙、无交互；与产品实然行为对齐（见 docs/PROJECT-obsidian-doc.md 验收清单） */
export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-14 leading-relaxed">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">隐私政策</h1>
      <p className="mt-2 text-sm text-neutral-500">最近更新：2026-10</p>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-semibold">我们收集什么</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li><strong>邮箱</strong>：仅用于注册、登录验证码与（经你 opt-in 的）每周学习周报。不发营销邮件。</li>
          <li><strong>学习数据</strong>：你输入的目标、计划、笔记、读书与对话内容。这些数据只属于你。</li>
          <li><strong>行为日志</strong>：功能漏斗埋点（如「开始引导」「生成计划」的匿名计数）与调用计量（服务商、token 数量），用于改进产品。<strong>不含对话原文，不含个人身份信息。</strong></li>
          <li><strong>IP 地址</strong>：仅用于限流与防滥用计数，不与学习数据关联分析。</li>
        </ul>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-semibold">数据如何保护</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>云端存储的所有学习数据经 <strong>AES-256-GCM 静态加密</strong>后落库，密钥独立于数据库保存。</li>
          <li>密码经 <strong>scrypt 单向加盐哈希</strong>存储——任何人（包括我们）都看不到原文。</li>
          <li>会话使用 HMAC 签名的 HttpOnly Cookie；改密/重置后旧设备会话全部吊销。</li>
          <li>你在「设置」中填入的模型 API Key（BYOK）<strong>只保存在你的浏览器本机</strong>，服务端仅转发请求、不落盘。</li>
        </ul>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-semibold">第三方服务</h2>
        <p>
          生成式功能需要把你的提问（以及教学必需的最小上下文）转发给你所选择（或服务端配置）的大模型服务商处理。
          我们不会出售你的数据，也不会用于广告。周报等邮件通过邮件服务商发送，仅含学习摘要。
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-semibold">删除与带走</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li><strong>账号注销</strong>：联系作者或经后台删除账号，云端数据（含密文与历史快照）一并清除。</li>
          <li><strong>本地数据</strong>：未注册时数据只存在你的浏览器，清空浏览器数据即彻底删除。</li>
          <li>你的数据随时可导出带走——数据归用户，这是产品底线。</li>
        </ul>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-semibold">联系我们</h2>
        <p>对隐私处理有任何疑问，通过应用内「反馈」直达作者。</p>
      </section>

      <p className="mt-12 text-sm">
        <Link href="/" className="text-neutral-500 underline-offset-4 hover:underline">← 返回首页</Link>
        {" · "}
        <Link href="/terms" className="text-neutral-500 underline-offset-4 hover:underline">用户协议</Link>
      </p>
    </main>
  );
}