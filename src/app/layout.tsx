import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { Toaster } from "sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mentora · 学习教练 × 第二大脑 × 人生伙伴",
  description:
    "苏格拉底式学习教练：从模糊愿望到可验收的学习计划；自带第二大脑与间隔复习；合并读书伙伴与名人智慧圆桌。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <AppShell>{children}</AppShell>
        <Toaster theme="dark" position="top-center" richColors />
      </body>
    </html>
  );
}
