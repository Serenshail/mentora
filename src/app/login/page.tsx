import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "登录 · Mentora",
};

/* 服务端读取 mode/next 后直接渲染表单：
 * 旧实现在客户端用 useSearchParams + Suspense，预渲染出的 HTML 只有空白占位，
 * 水合后才换成表单——首屏会整页闪一下。 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string | string[]; next?: string | string[] }>;
}) {
  const sp = await searchParams;
  const rawMode = Array.isArray(sp.mode) ? sp.mode[0] : sp.mode;
  const rawNext = Array.isArray(sp.next) ? sp.next[0] : sp.next;
  const initialMode = rawMode === "register" ? "register" : rawMode === "reset" ? "reset" : "login";
  return <LoginForm initialMode={initialMode} nextPath={rawNext ?? null} />;
}
