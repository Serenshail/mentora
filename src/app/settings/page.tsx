"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Input, PageHeader, Skeleton } from "@/components/ui";
import { useAppStore, DEFAULT_SETTINGS } from "@/lib/store";
import { useShallow } from "zustand/react/shallow";
import { useHydrated } from "@/lib/use-chat";
import { PageBackBar, readLastInAppRoute } from "@/components/page-back-bar";
import { PROVIDERS } from "@/lib/ai/providers";
import type { ProviderId } from "@/lib/types";
import { useAuth, pullCloud, getSyncWatermarkTs, markSyncWatermark, downloadLocalBackup } from "@/lib/auth-client";
import { assessCloudRestore, countRestoreItems, type RestoreCounts } from "@/lib/cloud-restore";
import { cn } from "@/lib/utils";
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
        /* 硬超时（auth-client 同族纪律：login 30s / logout 8s / me 12s）：连接挂起时
           既不回填姓名头像、也不走 catch 兜底，用户对着空表单以为资料丢了 */
        const res = await fetch("/api/auth/profile", { cache: "no-store", signal: AbortSignal.timeout(12_000) });
        const j = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error();
        setAvatar(j.user?.avatar ?? null);
        setName(j.user?.name ?? "");
      } catch {
        /* 读不到就用本地会话里的（useAuth 的 user 已带 name/avatar）——不回落到空值，
           否则用户看到空称呼输入框与字母占位头像，可能把空当成真实值保存。 */
        if (cancelled) return;
        setName(user?.name ?? "");
        setAvatar(user?.avatar ?? null);
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
        <div className="mt-5 flex flex-col gap-6 2xl:flex-row 2xl:items-center">
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
                <div className="flex size-20 items-center justify-center rounded-2xl bg-ink text-2xl font-black text-white">
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
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-1.5 text-xs font-medium text-ink transition hover:border-faint hover:bg-black/[0.02]"
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
                onChange={(e) => {
                  /* 读取后立刻重置 value：浏览器对未变化的 input.value 不再派发 change，
                   * 移除头像后想重新上传同一张图会点选后毫无反应（导入备份同理）。 */
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void pickAvatar(file);
                }}
              />
            </div>
          </div>

          {/* 称呼 */}
          <div className="min-w-0 flex-1">
            <label className="block text-xs text-ink-dim">
              怎么称呼你
              <div className="mt-1.5 flex flex-wrap gap-2">
                <Input
                  placeholder="教练会这样称呼你"
                  value={name}
                  maxLength={24}
                  onChange={(e) => setName(e.target.value)}
                  /* 中文输入法选词回车不该当提交：isComposing 期间放行给输入法（同 council 页口径） */
                  onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && saveName()}
                />
                <Button className="shrink-0" onClick={saveName} loading={savingName}>
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
                /* 30s 硬超时（login/register 同款）：移动网 TCP 半开时 savingPwd 会永久 true、
                   按钮无限转圈无任何反馈；服务端 db 层 withRetry 最坏 ≈22s，不能更短 */
                const res = await fetch("/api/auth/change-password", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd }),
                  signal: AbortSignal.timeout(30_000),
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
                /* 30s 硬超时：注销链路要写库/清会话/派生数据，挂起时 savingDel 锁死、
                   成功分支的跳转（partial 提示 / 立即回首页）永不执行 */
                const res = await fetch("/api/auth/account", {
                  method: "DELETE",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ password: delPwd }),
                  signal: AbortSignal.timeout(30_000),
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
                /* 服务端派生数据（data/ versions/）删除失败时带 partial 返回：档案已删、会话已清，
                 * 用户永远失去重试入口——必须如实告知残留，不能宣称"云端已删净"（运维日志有留痕）。
                 * 提示后延迟跳转：window.location 是整页刷新，立即跳转用户将看不到警告。 */
                const partial = Array.isArray(j.partial) ? (j.partial as string[]) : [];
                if (partial.length > 0) {
                  const labels = partial.map((k) => (k === "data" ? "学习数据" : k === "versions" ? "历史快照" : k));
                  toast.warning(`账号已注销，但云端${labels.join("、")}删除失败，有加密残留（已记录运维日志，可联系支持核查）`, { duration: 10000 });
                  setTimeout(() => (window.location.href = "/"), 8000);
                } else {
                  toast.success("账号已注销，云端与本机数据已删除");
                  setTimeout(() => (window.location.href = "/"), 600);
                }
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
  /* BYOK 三个字段逐键 setSettings 的代价：zustand persist 对每次 set 都同步执行
   * partialize + JSON.stringify 全仓并写盘（store.ts 自证「本地每次 set 都会同步触发
   * persist 写盘」；整库导入数百篇笔记时每个按键 = 数 MB 序列化 + 同步磁盘写）。
   * 改为本地缓冲 + 700ms 防抖一次性提交，失焦/卸载 flush——打字期间不再逐键写盘。
   * 水合（skipHydration 切仓）后用用户仓真实值对齐一次，匿名仓默认值不作数。 */
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [model, setModel] = useState(settings.model);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const draftRef = useRef<Record<string, string>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushDraft = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (Object.keys(draftRef.current).length === 0) return;
    setSettings(draftRef.current);
    draftRef.current = {};
  }, [setSettings]);
  const queueDraft = (patch: Record<string, string>) => {
    Object.assign(draftRef.current, patch);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(flushDraft, 700);
  };
  /* skipHydration 切仓（匿名仓 → 用户仓）后本地缓冲必须换成用户仓真实值。
   * 渲染期对齐（React「adjust state on prop change」官方模式）：水合前输入框未渲染
   * （!hydrated 直接返回骨架），不存在被覆盖的用户输入；不用 effect 里 setState。 */
  const [hydratedKey, setHydratedKey] = useState<"anon" | "user">("anon");
  if (hydratedKey !== (hydrated ? "user" : "anon")) {
    setHydratedKey(hydrated ? "user" : "anon");
    /* 水合对齐时输入框从未渲染（!hydrated 恒返回骨架），draftRef 必为空，无需清 */
    setApiKey(settings.apiKey);
    setModel(settings.model);
    setBaseUrl(settings.baseUrl);
  }
  /* 卸载 flush：store 是模块级单例，卸载后写安全；否则最后 700ms 内的编辑丢失 */
  useEffect(() => () => { flushDraft(); }, [flushDraft]);
  /* 「恢复默认」的二段式确认（与「清空全部数据」同款）：一键抹掉 BYOK Key 前先打招呼 */
  const [confirmModelReset, setConfirmModelReset] = useState(false);

  if (!hydrated) return <Skeleton className="h-40 rounded-2xl bg-surface/60" />;

  /* 兜底：provider 可能来自旧备份/云端快照，不保证是合法键——直接索引会 TypeError 崩整页 */
  const info = PROVIDERS[settings.provider] ?? PROVIDERS[DEFAULT_SETTINGS.provider];
  const showCustom = settings.provider === "custom";

  const pickProvider = (id: ProviderId) => {
    /* 已选中的卡片再点不应有破坏性：无条件把 model 写回默认会清掉用户手填的自定义
     * model id（deepseek-reasoner / 自建端点私有模型名），BYOK 下后续请求带错模型。 */
    if (settings.provider === id) return;
    /* 切走不清 baseUrl：自建端点地址是用户本机资产，切走再切回不该清空重填
     * （内置 provider 不读 baseUrl，保留无害）——与上方「重复点击不破坏」同一防破坏意图。
     * 读最新 store 值：flushDraft 刚提交的草稿不在本渲染闭包的 settings 里。 */
    flushDraft();
    const p = PROVIDERS[id];
    const cur = useAppStore.getState().settings;
    setSettings({
      provider: id,
      model: p.defaultModel,
      baseUrl: cur.baseUrl,
    });
    setModel(p.defaultModel);
    setBaseUrl(cur.baseUrl);
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
                    : "border-border hover:border-faint hover:bg-black/[0.02]"
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
              value={baseUrl}
              onBlur={flushDraft}
              onChange={(e) => { setBaseUrl(e.target.value); queueDraft({ baseUrl: e.target.value }); }}
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
                value={apiKey}
                onBlur={flushDraft}
                onChange={(e) => { setApiKey(e.target.value); queueDraft({ apiKey: e.target.value }); }}
              />
            </label>
            <label className="text-xs text-ink-dim">
              模型
              <Input
                className="mt-1"
                placeholder={info.defaultModel || "model-id"}
                value={model}
                onBlur={flushDraft}
                onChange={(e) => { setModel(e.target.value); queueDraft({ model: e.target.value }); }}
              />
              {info.modelHints.length > 0 && (
                <span className="mt-1.5 flex flex-wrap gap-1.5">
                  {info.modelHints.map((m) => (
                    <button
                      key={m}
                      onClick={() => { setModel(m); setSettings({ model: m }); }}
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
        {/* 只重置模型相关字段：setSettings 是 {...s.settings, ...patch} 合并，
            传整个 DEFAULT_SETTINGS 会把账户区设置的 userName/coachTone 一并清零。 */}
        {/* 二段式确认：BYOK apiKey 是用户自己申请并粘贴的本机资产，ghost 按钮零摩擦误触
            后必须重新去找/复制/粘贴——与「清空全部数据」「注销账号」同纪律。 */}
        <Button
          variant={confirmModelReset ? "danger" : "ghost"}
          onClick={() => {
            if (!confirmModelReset) {
              setConfirmModelReset(true);
              toast("再点一次确认：会清掉已保存的 API Key 与自定义模型");
              setTimeout(() => setConfirmModelReset(false), 4000);
              return;
            }
            setConfirmModelReset(false);
            if (debounceRef.current) {
              clearTimeout(debounceRef.current);
              debounceRef.current = null;
            }
            draftRef.current = {};
            setSettings({
              provider: DEFAULT_SETTINGS.provider,
              model: DEFAULT_SETTINGS.model,
              apiKey: DEFAULT_SETTINGS.apiKey,
              baseUrl: DEFAULT_SETTINGS.baseUrl,
            });
            setApiKey(DEFAULT_SETTINGS.apiKey);
            setModel(DEFAULT_SETTINGS.model);
            setBaseUrl(DEFAULT_SETTINGS.baseUrl);
          }}
        >
          <Save className="size-4" /> {confirmModelReset ? "确认恢复默认？" : "恢复默认（演示模式）"}
        </Button>
      </div>
    </div>
  );
}

/* ================= 数据 ================= */

function DataSection() {
  /* 就绪门控（与 AccountSection 的 checking 骨架、ModelSection 的 useHydrated 骨架同纪律）：
   * persist 是 skipHydration，store 要等 /api/auth/me 探测后 setStoreUser 切仓——此窗口内
   * 直接渲染会把匿名仓的「目标 0 · 笔记 0 · 书 0 · 对话 0」当成真实计数（用户可能误判
   * 「数据全丢了」而慌乱操作），且「清空全部数据」「从云端恢复」可点，操作落在匿名仓上、
   * 随后被切仓覆盖。 */
  const hydrated = useHydrated();
  const importData = useAppStore((s) => s.importData);
  const resetAll = useAppStore((s) => s.resetAll);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const exportAll = () => {
    downloadLocalBackup();
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

  /* 数据丢失兜底：直接从云端拉回（本地快照可能因配额为空,云端才是耐久存储）。
   * 但恢复是**整体覆盖**（store.ts:1742-1746 快照带全键时取云端、`??` 不保留本地），
   * 与「清空全部数据」同等破坏性：必须先拉取、比对云端与本机新旧/条目数，
   * 再要求二次确认，绝不一点直替。 */
  const [restoring, setRestoring] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<{
    data: Record<string, unknown>;
    updatedAt: string;
    assess: ReturnType<typeof assessCloudRestore>;
    /** 拉取那一刻的本机条目数：确认窗口内本机若又被写入，就不能按旧判断覆盖 */
    localSnapshot: RestoreCounts;
  } | null>(null);
  const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* 连点防抖：同一帧内两次 click 时 `restoring` 还是旧值（setState 尚未重渲染），
   * 会并发拉两次云端。ref 同步置位，保证第一次拉取完成前第二次点击直接忽略。 */
  const restoreInFlightRef = useRef(false);
  const clearPendingRestore = () => {
    if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current);
    restoreTimerRef.current = null;
    setPendingRestore(null);
  };
  // 切页/卸载时清掉待确认计时器，避免在已卸载组件上 setState
  useEffect(() => {
    return () => {
      if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current);
    };
  }, []);

  const localRestoreCounts = (): RestoreCounts => {
    const s = useAppStore.getState();
    return {
      goals: s.goals.length,
      knowledge: s.knowledge.length,
      books: s.books.length,
      sessions: s.sessions.length,
      customPersonas: s.customPersonas.length,
      agentSessions: s.agentSessions?.length ?? 0,
    };
  };

  const restoreFromCloud = async () => {
    if (restoring || restoreInFlightRef.current) return;
    // 第二次点击：覆盖的正是用户刚看到的这份快照（不重新拉取，避免确认内容与执行内容不一致）
    if (pendingRestore) {
      const p = pendingRestore;
      /* 确认窗口 20s 内本机可能又被写入（另一个标签页 / 自动同步拉回）：那时用户看到的
       * 「云端 N 条 / 本机 M 条」已经过时，按旧判断覆盖等于又一次静默覆盖——作废重来。 */
      if (JSON.stringify(localRestoreCounts()) !== JSON.stringify(p.localSnapshot)) {
        clearPendingRestore();
        toast.error("本机数据在确认期间有变化，已取消恢复；请重新点「从云端恢复」核对最新情况");
        return;
      }
      if (!importData(p.data)) {
        toast.error("云端数据格式不对，已保持本机不变");
        clearPendingRestore();
        return;
      }
      markSyncWatermark(p.updatedAt);
      clearPendingRestore();
      toast.success(`已从云端恢复（更新于 ${new Date(p.updatedAt).toLocaleString("zh-CN")}）`);
      return;
    }

    setRestoring(true);
    restoreInFlightRef.current = true;
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
      const localSnapshot = localRestoreCounts();
      const assess = assessCloudRestore({
        cloudUpdatedAt: cloud.updatedAt,
        localWatermarkTs: getSyncWatermarkTs(),
        cloud: countRestoreItems(cloud.data),
        local: localSnapshot,
      });
      setPendingRestore({ data: cloud.data, updatedAt: cloud.updatedAt, assess, localSnapshot });
      if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current);
      restoreTimerRef.current = setTimeout(() => {
        restoreTimerRef.current = null;
        setPendingRestore(null);
      }, 20_000);
      toast(
        assess.risky
          ? `${assess.cloudStale ? "云端快照不比本机新" : "云端条目比本机少"}（云端 ${assess.cloudTotal} 条 / 本机 ${assess.localTotal} 条），再点一次确认覆盖`
          : `将用云端快照覆盖本机（云端 ${assess.cloudTotal} 条），再点一次确认`
      );
    } catch {
      toast.error("拉取云端失败，稍后再试");
    } finally {
      restoreInFlightRef.current = false;
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

  if (!hydrated) return <Skeleton className="h-64 rounded-2xl bg-surface/60" />;

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
        <Button
          variant={pendingRestore ? "danger" : "outline"}
          onClick={restoreFromCloud}
          disabled={restoring}
        >
          <RefreshCw className={cn("size-4", restoring && "animate-spin")} />
          {restoring ? "恢复中…" : pendingRestore ? "确认覆盖本机？" : "从云端恢复"}
        </Button>
        {pendingRestore && (
          <Button variant="ghost" onClick={clearPendingRestore}>
            <X className="size-4" /> 取消
          </Button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            /* 同头像上传：重置 value，连续两次选同一个文件也能触发 */
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void importFile(file);
          }}
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
            /* 云端备份保留（pushOnce 空仓闸门）：如实告知用户兜底还在，别让「清空」
             * 听起来像两端皆失；也呼应下方「若刷新后本地变空，点『从云端恢复』」。 */
            toast.success("已清空本机数据（云端备份未动，可随时从云端恢复）");
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
      {pendingRestore && (
        <p className="mt-2 rounded-lg border border-bad/25 bg-bad/[0.04] px-3 py-2 text-xs leading-relaxed text-bad">
          云端快照更新于 {new Date(pendingRestore.updatedAt).toLocaleString("zh-CN")}：
          云端 {pendingRestore.assess.cloudTotal} 条 / 本机 {pendingRestore.assess.localTotal} 条。
          {pendingRestore.assess.risky && (
            <>
              {" "}
              <b>
                {pendingRestore.assess.cloudStale
                  ? "云端快照不比本机上次同步新"
                  : "云端条目比本机少"}
              </b>
              ——继续会整体覆盖本机目标、笔记、书、对话与自定义智能体（本机独有内容不可恢复），
              随后自动同步还会把这份快照推上云。需要保留的话先「导出备份」。
            </>
          )}{" "}
          20 秒内再点一次「确认覆盖本机？」生效。
        </p>
      )}
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
  useEffect(() => {
    const selectBackup = () => { if (window.location.hash === "#backup") setTab("data"); };
    const frame = requestAnimationFrame(selectBackup);
    window.addEventListener("hashchange", selectBackup);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("hashchange", selectBackup); };
  }, []);

  return (
    <div className="mx-auto max-w-4xl">
      {/* UI-04：设置一级页的固定返回——回到进入设置前的有效站内页面，没有则回首页 */}
      <PageBackBar title="设置" parentLabel="上一页" parentHref={readLastInAppRoute()} />
      <PageHeader
        icon={<KeyRound className="size-5" />}
        title="设置"
        desc="账户、模型与数据，都在这一页管。"
      />

      <div className="mt-8 grid min-w-0 gap-5 xl:grid-cols-[170px_minmax(0,1fr)] xl:gap-8">
        {/* 标签栏：桌面竖排 / 移动横排（命中盒 ≥44px，M3-1） */}
        <nav className="flex min-w-0 gap-1 overflow-x-auto xl:flex-col xl:gap-0.5 xl:overflow-visible">
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

        <div className="min-w-0">
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
  /* false=正常；"auth"=会话失效（401）；"temp"=暂时取不到（503/网络）——两者引导不同 */
  const [failed, setFailed] = useState<false | "auth" | "temp">(false);
  const [failDetail, setFailDetail] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  const load = () => {
    void (async () => {
      try {
        /* 12s 硬超时（/api/auth/me 同款）：挂起时邀请页永远停在骨架屏，没有 failed 提示也没有重试 */
        const res = await fetch("/api/referral", { cache: "no-store", signal: AbortSignal.timeout(12_000) });
        if (!res.ok) {
          /* API 区分了 401（未登录）与 503（邀请码暂时取不到）：不能一律当"暂时性故障"，
             否则登录状态失效会被展示成"稍后再试"，重试永远失败。读一下错误体归因。 */
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setFailDetail(typeof j.error === "string" ? j.error : "");
          setFailed(res.status === 401 ? "auth" : "temp");
          return;
        }
        setInfo(await res.json());
        setFailed(false);
      } catch {
        setFailDetail("");
        setFailed("temp");
      }
    })();
  };
  useEffect(load, []);

  if (failed) {
    return (
      <Card>
        <p className="text-sm font-bold text-ink">邀请</p>
        {failed === "auth" ? (
          <>
            <p className="mt-1.5 text-[13px] text-ink-dim">登录状态已失效，重新登录后再看邀请码。</p>
            <Button className="mt-3" size="sm" onClick={() => (window.location.href = "/login")}>
              去登录
            </Button>
          </>
        ) : (
          <>
            <p className="mt-1.5 text-[13px] text-ink-dim">{failDetail || "邀请码暂时取不到。"}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={load}>重试</Button>
          </>
        )}
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
            /* 与「复制邀请链接」「复制产品链接」同口径：成功后文案切成「已复制」2 秒 */
            if (ok) {
              setCodeCopied(true);
              setTimeout(() => setCodeCopied(false), 2000);
            } else {
              toast.error("复制失败，请手动选中");
            }
          }}
        >
          {codeCopied ? "已复制" : "复制邀请码"}
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
            {info.list.map((r, i) => (
              // key 用 at+i：email 是掩码（同域同首字母会撞），不再适合当唯一键
              <li key={`${r.at}-${i}`} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px]">
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
