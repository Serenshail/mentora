import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "Mentora",
  description:
    "想学什么，说一声。教练帮你定计划、盯验收、管复习；读书有伴，困惑有人跟你说真话。",
};

export default function RootLayout({ children }: { children: ReactNode }) {

  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <AppShell>{children}</AppShell>
        <Toaster theme="light" position="top-center" richColors />
      </body>
    </html>
  );
}
