"use client";
import { useState } from "react";
import Link from "next/link";
import { Button, Card } from "@/components/ui";
import { verifyBook } from "@/lib/book-verify";
import { useAppStore } from "@/lib/store";
import type { Book } from "@/lib/types";

export function BookEvidenceGate({ book }: { book: Book }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return <Card className="mx-auto max-w-xl">
    <h1 className="text-xl font-semibold">先确认《{book.title}》的来源</h1>
    <p className="mt-3 text-sm text-ink-dim">这本书尚未核实，已有目录也不能作为它真实存在的证据。确认前暂停阅读指导。</p>
    <Button className="mt-4" loading={busy} onClick={async () => {
      setBusy(true);
      try {
        const result = await verifyBook(book.title, book.author ?? "");
        if (result.status === "verified") useAppStore.getState().updateBook(book.id, { verification: "verified" });
        else setMessage("没有找到足够的书目证据。请核对书名、作者，或返回书架重新添加并提供原文。");
      } catch { setMessage("现在无法查询书目，请稍后重试。尚未生成任何新内容。"); }
      finally { setBusy(false); }
    }}>核实这本书</Button>
    {message && <p role="status" className="mt-3 text-sm text-warn">{message}</p>}
    <p className="mt-4 text-sm"><Link className="text-accent underline" href="/learn?tab=read">返回书架，核对书名或提供原文</Link></p>
  </Card>;
}
