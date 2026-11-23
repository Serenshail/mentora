"use client";

import Link from "next/link";
import { Brain } from "lucide-react";

export function NotesEntry() {
  return (
    <Link
      href="/brain"
      data-guide="notes-entry"
      onClick={() => {
        try { sessionStorage.setItem("mentora:notes-return", location.pathname + location.search); } catch { /* Storage may be unavailable. */ }
      }}
      className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm text-ink transition hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Brain className="size-4" /> 笔记库
    </Link>
  );
}
