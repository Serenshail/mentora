"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Input, PageHeader, Skeleton } from "@/components/ui";
import { useAppStore, DEFAULT_SETTINGS } from "@/lib/store";
import { useShallow } from "zustand/react/shallow";
import { useHydrated } from "@/lib/use-chat";
import { PROVIDERS } from "@/lib/ai/providers";
import type { ProviderId } from "@/lib/types";
import { useAuth, pullCloud } from "@/lib/auth-client";
import { cn, downloadJson } from "@/lib/utils";
import Link from "next/link";
import { toast } from "sonner";
import {
  Camera, Database, Download, Gift, KeyRound, LogOut, RefreshCw, Save, Trash2, Upload, UserRound, X,
} from "lucide-react";

/* ================= 账户：头像 + 称呼 ================= */

/** 选中的图片 → 居中裁剪到 256×256 JPEG dataURL（~30KB） */
async function fileToAvatar(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 不可用");
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

function AccountSection() {
  const { user, checking, updateProfile, logout } = useAuth();
  const setSettings = useAppStore((s) => s.setSettings);
  const coachTone = useAppStore(useShallow((s) => s.settings.coachTone ?? "standard"));
  const setTone = (t: "standard" | "gentle") => setSettings({ coachTone: t });
  const digestWeekly = useAppStore((s) => s.settings.digestWeekly ?? false);
  const [name, setName] = useState("");
  /* 退出的三态：旧实现是裸 await fetch —— 断网时按钮点了没反应、不跳转也不报错 */
  const [loggingOut, setLoggingOut] = useState(false);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  /* 安全：修改密码 / 注销账号 */
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [newPwd2, setNewPwd2] = useState("");
  const [savingPwd, setSavingPwd] = useState(false);
  const [delPwd, setDelPwd] = useState("");
  const [delPwd2, setDelPwd2] = useState(""); // 二次确认：再点一次才算
  const [savingDel, setSavingDel] = useState(false);

  /* 拉一次完整资料（含头像） */
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/profile", { cache: "no-store" });
        const j = await res.json();
        if (!res.ok || cancelled) return;
        setAvatar(j.user?.avatar ?? null);
        setName(j.user?.name ?? "");
      } catch {
        /* 读不到就用本地会话里的 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, checking]);

  if (checking) return <Skeleton className="h-64 rounded-2xl bg-surface/60" />;

  if (!user) {
    return (
      <Card className="p-8 text-center">
        <UserRound className="mx-auto size-8 text-ink-dim/50" strokeWidth={1.5} />
        <p className="mt-3 text-sm font-bold text-ink">当前是本机演示模式</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-dim">
          数据只存在这台电脑上。登录后可以换头像、改称呼，数据跟着账号走。
        </p>
        <Button className="mt-5" onClick={() => (window.location.href = "/login")}>
          去登录
        </Button>
      </Card>
    );
  }

  const pickAvatar = async (file: File) => {
    if (savingAvatar) return;
    try {
      const dataUrl = await fileToAvatar(file);
      setSavingAvatar(true);
      await updateProfile({ avatar: dataUrl });
      setAvatar(dataUrl);
      toast.success("头像已更新");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "头像上传失败");
    } finally {
      setSavingAvatar(false);
    }
  };

  const removeAvatar = async () => {
    if (savingAvatar) return;
    try {
      setSavingAvatar(true);
      await updateProfile({ avatar: null });
      setAvatar(null);
      toast.success("已恢复默认");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    } finally {
      setSavingAvatar(false);
    }
  };

  const saveName = async () => {
    if (savingName) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("称呼不能为空");
      return;
    }
    try {
      setSavingName(true);
      await updateProfile({ name: trimmed });
      setSettings({ userName: trimmed }); // 教练打招呼的称呼同步
      toast.success("称呼已更新");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingName(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 头像 + 称呼 */}
      <Card>
        <p className="text-sm font-bold text-ink">头像与称呼</p>
        <div className="mt-5 flex flex-col gap-6 sm:flex-row sm:items-center">
          {/* 头像 */}
          <div className="flex items-center gap-4">
            <div className="relative shrink-0">
              {avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={avatar}
                  alt="头像"
                  className="size-20 rounded-2xl border border-border object-cover"
                />
              ) : (
                <div className="flex size-20 items-center justify-center rounded-2xl bg-[#1d1d1f] text-2xl font-black text-white">
                  {(name || user.email).slice(0, 1).toUpperCase()}
                </div>
              )}
              {savingAvatar && (
                <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-white/70">
                  <span className="size-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-1.5 text-xs font-medium text-ink transition hover:border-[#d4d4d8] hover:bg-black/[0.02]"
              >
                <Camera className="size-3.5" /> 换头像
              </button>
              {avatar && (
                <button
                  type="button"
                  onClick={removeAvatar}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-ink-dim transition hover:text-bad"
                >
                  <X className="size-3.5" /> 移除
                </button>
              )}
              <p className="text-[11px] text-ink-dim/70">JPG / PNG / WebP，自动裁成正方形</p>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && pickAvatar(e.target.files[0])}
              />
            </div>
          </div>

          {/* 称呼 */}
          <div className="min-w-0 flex-1">
            <label className="block text-xs text-ink-dim">
              怎么称呼你
              <div className="mt-1.5 flex gap-2">
                <Input
                  placeholder="教练会这样称呼你"
                  value={name}
                  maxLength={24}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveName()}
                />
                <Button onClick={saveName} loading={savingName}>
                  <Save className="size-4" /> 保存
                </Button>
              </div>
            </label>
            <p className="mt-4 text-xs text-ink-dim">
              邮箱（登录用，不可改）
              <span className="mt-1.5 block rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px] text-ink-dim">
                {user.email}
              </span>
            </p>
          </div>
        </div>
      </Card>

      {/* 会员：状态 + 续费入口（真正操作在 /membership，避免设置页塞表单） */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-ink">会员</p>
            <p className="mt-1 text-xs text-ink-dim">
              {user.entitlement?.status === "legacy"
                ? "你的账号长期有效。"
                : user.entitlement?.status === "expired"
                  ? `已于 ${new Date(user.entitlement.expiresAt || "").toLocaleDateString("zh-CN")} 到期，AI 生成已暂停，数据仍在。`
                  : user.entitlement?.expiresAt
                    ? `有效期至 ${new Date(user.entitlement.expiresAt).toLocaleDateString("zh-CN")}，还剩 ${user.entitlement.daysLeft} 天。`
                    : "查看当前会员状态。"}
            </p>
          </div>
          <Link href="/membership">
            <Button variant="outline" size="sm">
              查看 / 续费
            </Button>
          </Link>
        </div>
      </Card>

      {/* 教练严厉度：只改语气，不改判分标准 */}
      <Card>
        <p className="text-sm font-bold text-ink">教练风格</p>
        <p className="mt-1 text-xs text-ink-dim">
          标准：直接指出缺口，不铺垫。温和：先具体说做对了什么，再把缺口说成「还差一步」。判分标准两档完全一致——只差语气。
        </p>
        <div className="mt-3 flex gap-2">
          {(["standard", "gentle"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTone(t)}
              aria-pressed={coachTone === t}
              className={cn(
                "cursor-pointer rounded-lg border px-4 py-2 text-[13px] transition",
                coachTone === t
                  ? "border-accent/50 bg-accent/[0.08] font-semibold text-accent"
                  : "border-border text-ink-dim hover:bg-black/[0.04] hover:text-ink"
              )}
            >
              {t === "standard" ? "标准 · 直接" : "温和 · 先扬后抑"}
            </button>
          ))}
        </div>
      </Card>

      {/* 复习召回：opt-in，随数据快照同步，仅发登录邮箱 */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-bold text-ink">每周复习邮件</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-dim">
              每周一上午一封：到期复习数量 + 上周完成情况。没有到期复习时不打扰。开关随你的加密数据同步，只发到登录邮箱，可在任何时候关闭。
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={digestWeekly}
            aria-label="每周复习邮件"
            onClick={() => {
              setSettings({ digestWeekly: !digestWeekly });
              toast.success(digestWeekly ? "已关闭每周复习邮件" : "已开启：每周一上午发送");
            }}
            className={cn(
              "relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition",
              digestWeekly ? "bg-accent" : "bg-black/15"
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-5 rounded-full bg-white shadow transition-all",
                digestWeekly ? "left-[22px]" : "left-0.5"
              )}
            />
          </button>
        </div>
      </Card>

      {/* 会话 */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-ink">登录会话</p>
            <p className="mt-1 text-xs text-ink-dim">30 天内免登录；退出后本机数据保留、云端备份不动。</p>
          </div>
          <Button
            variant="danger"
            loading={loggingOut}
            onClick={async () => {
              setLoggingOut(true);
              try {
                await logout();
              } catch (e) {
                /* 本地已按登出处理（不回滚用户操作），但要如实告知服务端没生效 */
                toast.error(e instanceof Error ? e.message : "退出登录未在服务端生效");
              } finally {
                setLoggingOut(false);
              }
              window.location.href = "/";
            }}
          >
            <LogOut className="size-4" /> 退出登录
          </Button>
        </div>
      </Card>

      {/* 安全：修改密码 + 注销账号 */}
      <Card>
        <p className="text-sm font-bold text-ink">修改密码</p>
        <p className="mt-1 text-xs text-ink-dim">
          新密码至少 6 位。其他已登录设备会在其会话到期（最长 30 天）后自动退出。
        </p>
        <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
          <Input
            type="password"
            placeholder="当前密码"
            autoComplete="current-password"
            value={oldPwd}
            onChange={(e) => setOldPwd(e.target.value)}
          />
          <Input
            type="password"
            placeholder="新密码（至少 6 位）"
            autoComplete="new-password"
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
          />
          <Input
            type="password"
            placeholder="再输一遍新密码"
            autoComplete="new-password"
            value={newPwd2}
            onChange={(e) => setNewPwd2(e.target.value)}
          />
        </div>
        <div className="mt-3 flex justify-end">
          <Button
            loading={savingPwd}
            onClick={async () => {
              if (savingPwd) return;
              if (!oldPwd || !newPwd) {
                toast.error("当前密码和新密码都要填");
                return;
              }
              if (newPwd !== newPwd2) {
                toast.error("两次输入的新密码不一致");
                return;
              }
              setSavingPwd(true);
              try {
                const res = await fetch("/api/auth/change-password", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd }),
                });
                const j = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(j.error || "修改失败");
                setOldPwd("");
                setNewPwd("");
                setNewPwd2("");
                toast.success("密码已更新，下次登录用新密码");
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "修改失败");
              } finally {
                setSavingPwd(false);
              }
            }}
          >
            <KeyRound className="size-4" /> 更新密码
          </Button>
        </div>
      </Card>

      {/* 危险区：注销账号 */}
      <Card className="border-bad/30 bg-bad/[0.03]">
        <p className="text-sm font-bold text-bad">注销账号</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-dim">
          永久删除该账号及其云端全部数据（学习计划、笔记、书、对话），<b className="text-bad">不可恢复</b>。
          本机缓存会一并清除。建议先在「数据」页导出一份备份。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            type="password"
            placeholder="输入登录密码以确认注销"
            autoComplete="current-password"
            value={delPwd}
            onChange={(e) => setDelPwd(e.target.value)}
            className="sm:max-w-xs"
          />
          <Button
            variant="danger"
            loading={savingDel}
            onClick={async () => {
              if (savingDel) return;
              if (!delPwd) {
                toast.error("先输入登录密码再点注销");
                return;
              }
              if (delPwd !== delPwd2) {
                toast.error("再点一次以确认注销（该操作不可恢复）");
                setDelPwd2(delPwd);
                return;
              }
              setSavingDel(true);
              try {
                const res = await fetch("/api/auth/account", {
                  method: "DELETE",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ password: delPwd }),
                });
                const j = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(j.error || "注销失败");
                const uidLocal = user.userId;
                /* 账号已注销：会话大概率已失效，logout 可能失败——不能让它阻断后面的本机清理 */
                try {
                  await logout();
                } catch { /* 忽略：下面照常清本机仓并跳转 */ }
                try {
                  localStorage.removeItem(`mentora-store-${uidLocal}`);
                  localStorage.removeItem("mentora-sync-choice");
                } catch { /* 忽略 */ }
                useAppStore.getState().resetAll();
                toast.success("账号已注销，云端与本机数据已删除");
                setTimeout(() => (window.location.href = "/"), 600);
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "注销失败");
              } finally {
                setSavingDel(false);
              }
            }}
          >
            <Trash2 className="size-4" /> 永久注销账号
          </Button>
        </div>
      </Card>
    </div>
  );
}

/* ================= 模型 ================= */

function ModelSection() {
  const hydrated = useHydrated();
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!hydrated) return <Skeleton className="h-40 rounded-2xl bg-surface/60" />;

  /* 兜底：provider 可能来自旧备份/云端快照，不保证是合法键——直接索引会 TypeError 崩整页 */
  const info = PROVIDERS[settings.provider] ?? PROVIDERS[DEFAULT_SETTINGS.provider];
  const showCustom = settings.provider === "custom";

  const pickProvider = (id: ProviderId) => {
    const p = PROVIDERS[id];
    setSettings({
      provider: id,
      model: p.defaultModel,
      baseUrl: id === "custom" ? settings.baseUrl : "",
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <p className="mb-4 text-sm font-bold text-ink">模型</p>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {(Object.keys(PROVIDERS) as ProviderId[]).map((id) => {
            const p = PROVIDERS[id];
            const selected = settings.provider === id;
            return (
              <button
                key={id}
                onClick={() => pickProvider(id)}
                className={cn(
                  "rounded-xl border p-3.5 text-left transition cursor-pointer",
                  selected
                    ? "border-accent/40 bg-accent/[0.06]"
                    : "border-border hover:border-[#d4d4d8] hover:bg-black/[0.02]"
                )}
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-bold text-ink">{p.name}</p>
                  {selected && <Badge tone="accent">已选择</Badge>}
                </div>
                {p.note && <p className="mt-1 text-xs text-ink-dim">{p.note}</p>}
                {id !== "demo" && id !== "custom" && (
                  <p className="mt-1 text-xs text-ink-dim">默认模型 {p.defaultModel}</p>
                )}
              </button>
            );
          })}
        </div>

        {showCustom && (
          <label className="mt-4 block text-xs text-ink-dim">
            Base URL（OpenAI 兼容，如 https://your-proxy.com/v1）
            <Input
              className="mt-1"
              placeholder="https://..."
              value={settings.baseUrl}
              onChange={(e) => setSettings({ baseUrl: e.target.value })}
            />
          </label>
        )}

        {settings.provider !== "demo" && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-ink-dim">
              API Key（只存你本机浏览器，请求时传给服务端转发）
              <Input
                className="mt-1"
                type="password"
                placeholder={settings.provider === "custom" ? "（端点需公网 HTTPS；转发鉴权用你自己的 Key）" : "sk-..."}
                value={settings.apiKey}
                onChange={(e) => setSettings({ apiKey: e.target.value })}
              />
            </label>
            <label className="text-xs text-ink-dim">
              模型
              <Input
                className="mt-1"
                placeholder={info.defaultModel || "model-id"}
                value={settings.model}
                onChange={(e) => setSettings({ model: e.target.value })}
              />
              {info.modelHints.length > 0 && (
                <span className="mt-1.5 flex flex-wrap gap-1.5">
                  {info.modelHints.map((m) => (
                    <button
                      key={m}
                      onClick={() => setSettings({ model: m })}
                      className="rounded-md border border-border bg-white px-2 py-0.5 text-[11px] text-ink-dim hover:text-ink hover:border-accent/40 cursor-pointer"
                    >
                      {m}
                    </button>
                  ))}
                </span>
              )}
            </label>
          </div>
        )}

        {info.keyUrl && (
          <a
            href={info.keyUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block text-xs text-accent hover:underline"
          >
            ↗ 获取 {info.name} API Key
          </a>
        )}
        {settings.provider === "demo" && (
          <p className="mt-3 rounded-xl border border-ok/25 bg-ok/[0.06] p-3 text-xs text-ok">
            「自动」模式：优先使用部署者在服务端配置的模型（当前已配置 DeepSeek）；服务端未配置 Key 时回退为演示模式。
            想用自己的 Key？选上面任意服务商并填入，费用归你。
          </p>
        )}
      </Card>

      <div className="flex justify-end">
        <Button variant="ghost" onClick={() => setSettings({ ...DEFAULT_SETTINGS })}>
          <Save className="size-4" /> 恢复默认（演示模式）
        </Button>
      </div>
    </div>
  );
}

/* ================= 数据 ================= */

function DataSection() {
  const importData = useAppStore((s) => s.importData);
  const resetAll = useAppStore((s) => s.resetAll);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const exportAll = () => {
    const s = useAppStore.getState();
    downloadJson(`mentora-backup-${new Date().toISOString().slice(0, 10)}.json`, {
      exportedAt: new Date().toISOString(),
      goals: s.goals,
      knowledge: s.knowledge,
      books: s.books,
      sessions: s.sessions,
      settings: { ...s.settings, apiKey: "" },
    });
    toast.success("已导出备份 JSON（不含 API Key）");
  };

  const importFile = async (file: File) => {
    try {
      const data: unknown = JSON.parse(await file.text());
      /* 结构校验在 store 里做：坏数据一旦进 store 会被 persist 落盘，
       * 刷新后 goals.map / PROVIDERS[provider] 直接 TypeError，应用内连「清空数据」都点不到。 */
      if (!importData(data)) {
        toast.error("文件结构不对（goals/knowledge 等字段不是预期的数组），未导入任何数据");
        return;
      }
      toast.success("导入成功");
    } catch {
      toast.error("文件不是合法 JSON，导入失败");
    }
  };

  /* 数据丢失兜底：直接从云端拉回（本地快照可能因配额为空,云端才是耐久存储） */
  const [restoring, setRestoring] = useState(false);
  const restoreFromCloud = async () => {
    setRestoring(true);
    try {
      const cloud = await pullCloud();
      if (cloud.status === "error") {
        toast.error(`拉取云端失败：${cloud.message}`);
        return;
      }
      if (cloud.status === "empty") {
        toast.error("云端没有备份数据（可能从未成功推送过）");
        return;
      }
      if (!importData(cloud.data)) {
        toast.error("云端数据格式不对，已保持本机不变");
        return;
      }
      toast.success(`已从云端恢复（更新于 ${new Date(cloud.updatedAt).toLocaleString("zh-CN")}）`);
    } catch {
      toast.error("拉取云端失败，稍后再试");
    } finally {
      setRestoring(false);
    }
  };

  // 注意:zustand v5 选择器返回新对象必须 useShallow,否则无限重渲染白屏(踩坑档案 #1 的第二次踩)
  const local = useAppStore(
    useShallow((s) => ({
      goals: s.goals.length,
      knowledge: s.knowledge.length,
      books: s.books.length,
      sessions: s.sessions.length,
    }))
  );

  return (
    <Card>
      <p className="mb-3 text-sm font-bold text-ink">数据</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={exportAll}>
          <Download className="size-4" /> 导出备份
        </Button>
        <Button variant="outline" onClick={() => fileRef.current?.click()}>
          <Upload className="size-4" /> 导入备份
        </Button>
        <Button variant="outline" onClick={restoreFromCloud} disabled={restoring}>
          <RefreshCw className={cn("size-4", restoring && "animate-spin")} /> {restoring ? "恢复中…" : "从云端恢复"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])}
        />
        <Button
          variant="danger"
          onClick={() => {
            if (!confirmReset) {
              setConfirmReset(true);
              toast("再点一次确认清空（不可恢复）");
              setTimeout(() => setConfirmReset(false), 4000);
              return;
            }
            resetAll();
            setConfirmReset(false);
            toast.success("已清空全部数据");
          }}
        >
          <Trash2 className="size-4" /> {confirmReset ? "确认清空？" : "清空全部数据"}
        </Button>
      </div>
      <p className="mt-3 text-xs text-ink-dim">
        本机当前：目标 {local.goals} · 笔记 {local.knowledge} · 书 {local.books} · 对话 {local.sessions}。
      </p>
      <p className="mt-1 text-xs text-ink-dim">
        登录后数据自动同步云端（加密存储）；不登录则只在这台电脑上，换设备前先导出。若刷新后本地变空，点「从云端恢复」。
      </p>
    </Card>
  );
}

/* ================= 页面 ================= */

const TABS = [
  { id: "account", label: "账户", icon: UserRound },
  { id: "model", label: "模型", icon: KeyRound },
  { id: "data", label: "数据", icon: Database },
  { id: "invite", label: "邀请", icon: Gift },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function SettingsPage() {
  const [tab, setTab] = useState<TabId>("account");

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        icon={<KeyRound className="size-5" />}
        title="设置"
        desc="账户、模型与数据，都在这一页管。"
      />

      <div className="mt-8 grid gap-8 md:grid-cols-[170px_1fr]">
        {/* 标签栏：桌面竖排 / 移动横排（命中盒 ≥44px，M3-1） */}
        <nav className="flex gap-1 overflow-x-auto md:flex-col md:gap-0.5 md:overflow-visible">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              aria-current={tab === id ? "page" : undefined}
              className={cn(
                "flex min-h-[44px] shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-3.5 py-2 text-[13.5px] font-medium transition",
                tab === id
                  ? "bg-black/[0.05] font-semibold text-ink"
                  : "text-ink-dim hover:bg-black/[0.035] hover:text-ink"
              )}
            >
              <Icon className="size-[17px]" strokeWidth={1.75} />
              {label}
            </button>
          ))}
        </nav>

        <div>
          {tab === "account" && <AccountSection />}
          {tab === "model" && <ModelSection />}
          {tab === "data" && <DataSection />}
          {tab === "invite" && (
            <>
              <ReferralSection />
              <div className="mt-5">
                <GroupSection />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ================= 邀请（拉新）：我的邀请码 + 拉新战绩 ================= */
/* 用户定（2026-11-05）：拉一个新用户送一个月；邀请码放设置页，不单独占导航位。 */
interface RefInfo {
  refCode: string;
  invited: number;
  rewardedCount: number;
  rewardedDays: number;
  rewardDays: number;
  list: { email: string; at: string; rewarded: boolean }[];
}

function ReferralSection() {
  const [info, setInfo] = useState<RefInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const load = () => {
    void (async () => {
      try {
        const res = await fetch("/api/referral", { cache: "no-store" });
        if (!res.ok) throw new Error();
        setInfo(await res.json());
      } catch {
        setFailed(true);
      }
    })();
  };
  useEffect(load, []);

  if (failed) {
    return (
      <Card>
        <p className="text-sm font-bold text-ink">邀请</p>
        <p className="mt-1.5 text-[13px] text-ink-dim">邀请码暂时取不到。</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={load}>重试</Button>
      </Card>
    );
  }
  if (!info) return <Skeleton className="h-44 rounded-2xl bg-surface/60" />;

  const link = typeof window !== "undefined" ? `${window.location.origin}/login?mode=register&ref=${info.refCode}` : "";

  return (
    <Card>
      <p className="text-sm font-bold text-ink">拉一个朋友，你多一个月</p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-dim">
        朋友注册时填你的邀请码（或直接用你的链接），他开通后<b className="text-ink">你这边自动加 {info.rewardDays} 天</b>。
        朋友需要自己有一张激活码，或先在首页申请 7 天体验。
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <code className="rounded-lg border border-border bg-surface-2 px-3.5 py-2 font-mono text-lg tracking-[0.2em] text-ink">
          {info.refCode}
        </code>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const { copyText } = await import("@/lib/utils");
            const ok = await copyText(info.refCode);
            if (ok) toast.success("已复制邀请码");
            else toast.error("复制失败，请手动选中");
          }}
        >
          复制邀请码
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const { copyText } = await import("@/lib/utils");
            const ok = await copyText(link);
            if (ok) {
              setLinkCopied(true);
              setTimeout(() => setLinkCopied(false), 2000);
            } else {
              toast.error("复制失败，请手动复制下方链接");
            }
          }}
        >
          {linkCopied ? "已复制" : "复制邀请链接"}
        </Button>
      </div>
      <p className="mt-2 font-mono text-[11px] break-all text-ink-dim/70">{link}</p>

      <div className="mt-4 grid grid-cols-3 gap-3 text-center">
        <div className="rounded-xl border border-border bg-surface-2 px-2 py-3">
          <p className="text-lg font-bold tabular text-ink">{info.invited}</p>
          <p className="mt-0.5 text-[11px] text-ink-dim">已邀请</p>
        </div>
        <div className="rounded-xl border border-border bg-surface-2 px-2 py-3">
          <p className="text-lg font-bold tabular text-ink">{info.rewardedCount}</p>
          <p className="mt-0.5 text-[11px] text-ink-dim">已开通</p>
        </div>
        <div className="rounded-xl border border-border bg-surface-2 px-2 py-3">
          <p className="text-lg font-bold tabular text-ink">+{info.rewardedDays}</p>
          <p className="mt-0.5 text-[11px] text-ink-dim">已得天数</p>
        </div>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-dim/70">
        30 天内最多结算 10 次奖励；自己邀请自己的不计。朋友注册成功后这里立刻更新。
      </p>

      {info.list.length > 0 && (
        <div className="mt-4">
          <p className="text-[13px] font-semibold text-ink">我邀请的人</p>
          <ul className="mt-2 space-y-1.5">
            {info.list.map((r) => (
              <li key={r.email} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px]">
                <span className="min-w-0 truncate text-ink">{r.email}</span>
                <span className="flex shrink-0 items-center gap-2 text-[11px] text-ink-dim">
                  {new Date(r.at).toLocaleDateString("zh-CN")}
                  <Badge tone={r.rewarded ? "ok" : "dim"}>{r.rewarded ? "已结算 +30 天" : "未结算"}</Badge>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-ink-dim/70">
            朋友的朋友再用朋友的邀请码注册，链条会在后台一路记下去——每一级都能查到上一级是谁。
          </p>
        </div>
      )}
    </Card>
  );
}

/* ================= 推荐：扫码进微信 / 飞书交流群 ================= */
function GroupSection() {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    // v17：SSR 期拿不到 window，客户端一帧后补 origin（effect 同步 setState 是 lint 红线）
    const t = setTimeout(() => setOrigin(window.location.origin), 0);
    return () => clearTimeout(t);
  }, []);
  return (
    <Card className="p-6">
      <p className="text-sm font-bold text-ink">加入 Mentora 交流群</p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-dim">
        微信扫码进微信交流反馈群，飞书扫码进飞书协作群。新功能预告、用法答疑、吐槽反馈都在群里。
        想把 Mentora 推荐给朋友，转发产品链接或群码都可以。
      </p>
      <div className="mt-5 flex flex-wrap items-start gap-6">
        <figure className="m-0">
          <div className="rounded-2xl border border-border bg-white p-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/wechat-group-qr.jpg"
              alt="微信交流反馈群二维码"
              className="h-auto w-[132px] rounded-lg"
            />
          </div>
          <figcaption className="mt-2 text-center text-[12px] text-ink-dim">微信 · 交流反馈群</figcaption>
        </figure>
        <figure className="m-0">
          <div className="rounded-2xl border border-border bg-white p-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/feishu-group-qr.jpg"
              alt="飞书协作群二维码"
              className="h-auto w-[132px] rounded-lg"
            />
          </div>
          <figcaption className="mt-2 text-center text-[12px] text-ink-dim">飞书 · 协作群</figcaption>
        </figure>
        <div className="space-y-2 text-[13px] text-ink-dim">
          <p className="font-mono text-[12px] text-ink">{origin || "…"}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const { copyText } = await import("@/lib/utils");
              const ok = await copyText(origin);
              if (ok) {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } else {
                toast.error("复制失败，请手动全选上面的链接复制");
              }
            }}
          >
            {copied ? "已复制" : "复制产品链接"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
