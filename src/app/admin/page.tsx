"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Card, Input } from "@/components/ui";
import { toast } from "sonner";
import { KeyRound, RefreshCcw, Users } from "lucide-react";

interface UserRow {
  email: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  goals: { topic?: string; direction?: string }[];
  knowledgeCount: number;
  booksCount: number;
  sessionsCount: number;
}

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (pwd?: string) => {
    const p = pwd ?? password;
    if (!p) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: p }),
      });
      const j = await res.json();
      if (!res.ok) {
        toast.error(j.error || "加载失败");
        if (res.status === 401) setRows(null);
        return;
      }
      setRows(j.rows);
      setPassword(p);
      sessionStorage.setItem("mentora-admin-pwd", p);
    } finally {
      setBusy(false);
    }
  };

  // 已解锁过则本会话自动恢复
  useEffect(() => {
    const saved = sessionStorage.getItem("mentora-admin-pwd");
    if (saved) {
      setPassword(saved);
      void load(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-xl bg-accent/15 text-[#b7adff] border border-accent/25">
          <Users className="size-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-[-0.02em] text-white">作者后台</h1>
          <p className="text-xs text-ink-dim">注册用户与他们云端的全部数据概况</p>
        </div>
      </div>

      {!rows ? (
        <Card className="mx-auto max-w-sm">
          <p className="mb-3 flex items-center gap-2 text-sm font-bold text-white">
            <KeyRound className="size-4" /> 管理密码
          </p>
          <Input
            type="password"
            placeholder="ADMIN_PASSWORD"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
          />
          <Button className="mt-3 w-full" onClick={() => load()} loading={busy}>
            进入
          </Button>
        </Card>
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between">
            <Badge tone="accent">共 {rows.length} 个用户</Badge>
            <Button variant="outline" size="sm" onClick={() => load()} loading={busy}>
              <RefreshCcw className="size-3.5" /> 刷新
            </Button>
          </div>
          {rows.length === 0 ? (
            <Card className="py-12 text-center text-sm text-ink-dim">
              还没有用户。分享出去，这里就会亮起来。
            </Card>
          ) : (
            <div className="space-y-3">
              {rows.map((r, i) => (
                <Card key={i}>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <p className="text-sm font-bold text-white">{r.name}</p>
                    <p className="text-xs text-ink-dim">{r.email}</p>
                    <Badge tone="dim" className="ml-auto">
                      最近活跃 {r.updatedAt === "从未同步" ? "从未同步" : new Date(r.updatedAt).toLocaleString("zh-CN")}
                    </Badge>
                  </div>
                  <div className="tabular mt-3 flex flex-wrap gap-4 text-xs text-ink-dim">
                    <span>📚 学习目标 <b className="text-ink">{r.goals.length}</b></span>
                    <span>🧠 知识 <b className="text-ink">{r.knowledgeCount}</b></span>
                    <span>📖 书 <b className="text-ink">{r.booksCount}</b></span>
                    <span>💬 对话 <b className="text-ink">{r.sessionsCount}</b></span>
                    <span className="text-ink-dim/60">注册于 {r.createdAt === "?" ? "?" : new Date(r.createdAt).toLocaleDateString("zh-CN")}</span>
                  </div>
                  {r.goals.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {r.goals.map((g, j) => (
                        <p key={j} className="truncate text-xs text-ink-dim">
                          · <b className="text-ink">{g.topic}</b> — {g.direction}
                        </p>
                      ))}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
