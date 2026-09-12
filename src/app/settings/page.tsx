"use client";

import { useRef, useState } from "react";
import { Badge, Button, Card, Input, PageHeader } from "@/components/ui";
import { useAppStore, DEFAULT_SETTINGS } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { PROVIDERS } from "@/lib/ai/providers";
import type { ProviderId } from "@/lib/types";
import { cn, downloadJson } from "@/lib/utils";
import { toast } from "sonner";
import { Database, Download, KeyRound, Save, Trash2, Upload, User } from "lucide-react";

export default function SettingsPage() {
  const hydrated = useHydrated();
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const importData = useAppStore((s) => s.importData);
  const resetAll = useAppStore((s) => s.resetAll);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!hydrated) return <div className="h-40 animate-pulse rounded-2xl bg-surface/60" />;

  const info = PROVIDERS[settings.provider];
  const showCustom = settings.provider === "custom";

  const pickProvider = (id: ProviderId) => {
    const p = PROVIDERS[id];
    setSettings({
      provider: id,
      model: p.defaultModel,
      baseUrl: id === "custom" ? settings.baseUrl : "",
    });
  };

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
      const data = JSON.parse(await file.text());
      importData(data);
      toast.success("导入成功");
    } catch {
      toast.error("文件格式不对，导入失败");
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        icon={<KeyRound className="size-5" />}
        title="设置"
        desc="连接你自己的模型（BYOK，费用归你），或用演示模式体验全部功能。所有数据只存在本机浏览器。"
      />

      {/* Provider 选择 */}
      <Card className="mb-6">
        <p className="mb-4 text-sm font-bold text-white">🔌 模型服务</p>
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
                    ? "border-accent/60 bg-accent/10"
                    : "border-border hover:border-accent/30 hover:bg-white/5"
                )}
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-bold text-white">{p.name}</p>
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
                placeholder={settings.provider === "custom" ? "（若端点无需鉴权可留空）" : "sk-..."}
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
                      className="rounded-md border border-border px-2 py-0.5 text-[11px] text-ink-dim hover:text-ink hover:border-accent/40 cursor-pointer"
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
            className="mt-3 inline-block text-xs text-[#22d3ee] hover:underline"
          >
            ↗ 获取 {info.name} API Key
          </a>
        )}
        {settings.provider === "demo" && (
          <p className="mt-3 rounded-xl border border-ok/30 bg-ok/10 p-3 text-xs text-ok/90">
            「自动」模式：优先使用部署者在服务端配置的模型（当前已配置 DeepSeek）；服务端未配置 Key 时回退为演示模式。
            想用自己的 Key？选上面任意服务商并填入，费用归你。
          </p>
        )}
      </Card>

      {/* 用户名 */}
      <Card className="mb-6">
        <p className="mb-3 flex items-center gap-2 text-sm font-bold text-white">
          <User className="size-4" /> 你怎么称呼
        </p>
        <Input
          placeholder="教练会这样称呼你"
          value={settings.userName}
          onChange={(e) => setSettings({ userName: e.target.value })}
        />
      </Card>

      {/* 数据管理 */}
      <Card className="mb-6">
        <p className="mb-3 flex items-center gap-2 text-sm font-bold text-white">
          <Database className="size-4" /> 数据（全部在本机 localStorage）
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={exportAll}>
            <Download className="size-4" /> 导出备份
          </Button>
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload className="size-4" /> 导入备份
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
          换设备 / 换浏览器前先导出。多端同步、账号体系与云端数据库是 v2 路线（见 README）。
        </p>
      </Card>

      <div className="flex justify-end">
        <Button variant="ghost" onClick={() => setSettings({ ...DEFAULT_SETTINGS })}>
          <Save className="size-4" /> 恢复默认（演示模式）
        </Button>
      </div>
    </div>
  );
}
