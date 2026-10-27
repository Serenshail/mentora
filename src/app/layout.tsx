import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { ChunkRecovery } from "@/components/chunk-recovery";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "Mentora",
  description:
    "想学什么，说一声。教练帮你定计划、盯验收、管复习；读书有伴，困惑有人跟你说真话。",
};

/* 移动 viewport 契约（PRD-2026-10-26-MOBILE-UI §4.6）：
 * viewportFit=cover 让 env(safe-area-inset-*) 生效；themeColor 与浅色设计系统一致。
 * 这只是 Web viewport 声明，不等于 PWA。 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f5f5f7",
};

export default function RootLayout({ children }: { children: ReactNode }) {

  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <ChunkRecovery />
        <AppShell>{children}</AppShell>
        <Toaster theme="light" position="top-center" richColors />
      </body>
    </html>
  );
}
