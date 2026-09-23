"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Input, Modal, PageHeader } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { useAppStore } from "@/lib/store";
import { useChat, useHydrated } from "@/lib/use-chat";
import {
  PERSONAS, personaById,
} from "@/lib/ai/prompts";
import { extractJson, personaDistillSchema, streamChat } from "@/lib/ai/client";
import { cn, uid } from "@/lib/utils";
import { toast } from "sonner";
import { Compass, FlaskConical, Plus, Trash2, UserPlus, Users, Zap } from "lucide-react";
import type { Persona as BuiltinPersona } from "@/lib/ai/prompts";
import type { CustomPersona } from "@/lib/types";

type ResolvedPersona = BuiltinPersona | (CustomPersona & { id: string });

/* 内置 12 席的 hedcut 点刻肖像（public/personas/）；自建人物回落到墨色首字母 */
const PORTRAITS: Record<string, string> = {
  naval: "/personas/naval.jpg",
  jobs: "/personas/jobs.jpg",
  munger: "/personas/munger.jpg",
  feynman: "/personas/feynman.jpg",
  taleb: "/personas/taleb.jpg",
  graham: "/personas/graham.jpg",
  karpathy: "/personas/karpathy.jpg",
  musk: "/personas/musk.jpg",
  zhangxuefeng: "/personas/zhangxuefeng.jpg",
  zhangyiming: "/personas/zhangyiming.jpg",
  mrbeast: "/personas/mrbeast.jpg",
  sutskever: "/personas/sutskever.jpg",
};

function PersonaAvatar({
  id,
  name,
  className,
}: {
  id: string;
  name: string;
  className?: string; // 尺寸由调用方给，如 size-9 / size-10
}) {
  const src = PORTRAITS[id];
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        className={cn("shrink-0 rounded-xl border border-border bg-surface-2 object-cover", className)}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl bg-[#1a1a1a] font-black text-white",
        className
      )}
    >
      {name.slice(0, 1)}
    </div>
  );
}

export default function CouncilPage() {
  const hydrated = useHydrated();
  const sessions = useAppStore((s) => s.sessions);
  const addSession = useAppStore((s) => s.addSession);
  const addSessionMsg = useAppStore((s) => s.addSessionMsg);
  const removeSession = useAppStore((s) => s.removeSession);
  const customPersonas = useAppStore((s) => s.customPersonas);
  const addCustomPersona = useAppStore((s) => s.addCustomPersona);
  const removeCustomPersona = useAppStore((s) => s.removeCustomPersona);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const { messages, setMessages, pending, streaming, send } = useChat();
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  // 圆桌状态
  const [rtParticipants, setRtParticipants] = useState<string[]>([]);
  const [rtTakes, setRtTakes] = useState<Record<string, string>>({});
  const [rtHost, setRtHost] = useState("");

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const isRoundtable = active?.personaId === "roundtable";

  const resolvePersona = (personaId: string): ResolvedPersona | null | undefined => {
    if (personaId === "roundtable") return null;
    const builtin = personaById(personaId);
    if (builtin) return builtin;
    const c = customPersonas.find((x) => x.id === personaId);
    if (c) return { ...c, system: c.system };
    return undefined;
  };
  const persona = active ? resolvePersona(active.personaId) : undefined;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending, rtTakes, rtHost]);

  useEffect(() => {
    if (active) setMessages(active.messages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const allPersonaOptions = [
    ...PERSONAS.map((p) => ({ id: p.id, name: p.name, color: p.color, custom: false })),
    ...customPersonas.map((c) => ({ id: c.id, name: c.name, color: c.color, custom: true })),
  ];

  const startWith = async (personaId: string) => {
    setPicking(false);
    const sessionId = uid("sess");
    if (personaId === "roundtable") {
      // 先选与会者（默认全选），选完创建
      setRtParticipants(allPersonaOptions.map((p) => p.id));
      setPicking(false);
      setForgeRoundtableOpen(true);
      return;
    }
    const p = resolvePersona(personaId);
    addSession({
      id: sessionId,
      personaId,
      title: p ? p.name : "对话",
      messages: [],
      createdAt: new Date().toISOString(),
    });
    setActiveId(sessionId);
    setMessages([]);
    await send({
      args: { mode: "single", personaId: p?.id, customSystem: p && "identityNote" in p ? p.system : undefined },
      userText: "（请用你的风格开场：你是谁、你处理什么问题、以及你会先反问用户什么。50字内，不要列清单。）",
      task: "council",
      onDone: (full) => {
        if (full)
          addSessionMsg(sessionId, {
            id: uid("m"),
            role: "assistant",
            content: full,
            at: new Date().toISOString(),
          });
      },
    });
  };

  /* 圆桌会话创建（选完与会者） */
  const [forgeRoundtableOpen, setForgeRoundtableOpen] = useState(false);
  const createRoundtable = () => {
    if (rtParticipants.length < 2) {
      toast.error("圆桌至少 2 位与会者");
      return;
    }
    const sessionId = uid("sess");
    const names = rtParticipants
      .map((id) => allPersonaOptions.find((p) => p.id === id)?.name ?? id)
      .join(" · ");
    addSession({
      id: sessionId,
      personaId: "roundtable",
      participants: [...rtParticipants],
      title: `圆桌(${rtParticipants.length}人)：${names.slice(0, 24)}…`,
      messages: [],
      createdAt: new Date().toISOString(),
    });
    setActiveId(sessionId);
    setMessages([]);
    setForgeRoundtableOpen(false);
    toast.success("圆桌已就位——把问题扔进来，每位与会者都会独立发言，最后有主持人纪要。");
  };

  /* 单人对话发送 */
  const doSend = () => {
    const text = input.trim();
    if (!text || streaming || !active) return;
    if (isRoundtable) {
      void roundtableSend(text);
      setInput("");
      return;
    }
    setInput("");
    const base = active.messages;
    const userMsg = { id: uid("m"), role: "user" as const, content: text, at: new Date().toISOString() };
    addSessionMsg(active.id, userMsg);
    void send({
      args: { mode: "single", personaId: persona?.id, customSystem: persona && "identityNote" in persona ? persona.system : undefined },
      userText: text,
      task: "council",
      history: base,
      onDone: (full) => {
        if (full)
          addSessionMsg(active.id, {
            id: uid("m"),
            role: "assistant",
            content: full,
            at: new Date().toISOString(),
          });
      },
      temperature: 0.8,
    });
  };

  /* 圆桌发送：全员并行独立发言 → 主持人纪要 */
  const [rtBusy, setRtBusy] = useState(false);
  const roundtableSend = async (text: string) => {
    if (!active) return;
    setRtBusy(true);
    setRtTakes({});
    setRtHost("");
    const userMsg = { id: uid("m"), role: "user" as const, content: text, at: new Date().toISOString() };
    addSessionMsg(active.id, userMsg);
    // 立即同步到聊天状态，让提问在生成期间就可见
    setMessages([...active.messages, userMsg]);
    setInput("");

    const participants = (active.participants ?? []).map((id) => resolvePersona(id)).filter(Boolean) as ResolvedPersona[];
    const takesMap: Record<string, string> = {};

    // 并行独立发言
    await Promise.all(
      participants.map(async (p) => {
        let take = "";
        try {
          const full = await streamChat({
            task: "council",
            args: { mode: "take", name: p.name, personaId: p.id, customSystem: p.system },
            messages: [{ role: "user", content: text }],
            temperature: 0.8,
            onDelta: (d) => {
              take += d;
              setRtTakes((prev) => ({ ...prev, [p.id]: take }));
            },
          });
          takesMap[p.id] = full || take;
          addSessionMsg(active.id, {
            id: uid("m"),
            role: "assistant",
            content: `**【${p.name}】**\n\n${takesMap[p.id]}`,
            at: new Date().toISOString(),
          });
        } catch {
          takesMap[p.id] = take || "（发言失败）";
          addSessionMsg(active.id, {
            id: uid("m"),
            role: "assistant",
            content: `**【${p.name}】**（发言失败）`,
            at: new Date().toISOString(),
          });
        }
      })
    );

    // 主持人纪要
    try {
      const names = participants.map((p) => p.name).join("、");
      const takes = participants
        .map((p) => `【${p.name}】${takesMap[p.id] ?? ""}`)
        .join("\n\n");
      const full = await streamChat({
        task: "council",
        args: { mode: "host", names, takes },
        messages: [{ role: "user", content: "请写圆桌纪要。" }],
        temperature: 0.4,
        onDelta: (d) => setRtHost((p) => p + d),
      });
      addSessionMsg(active.id, {
        id: uid("m"),
        role: "assistant",
        content: `## 圆桌纪要\n\n${full}`,
        at: new Date().toISOString(),
      });
    } catch {
      toast.error("主持人纪要生成失败");
    }
    // 全量同步：把圆桌的所有发言与纪要显示出来（这是清零 bug 的修复）
    const finalMsgs = useAppStore.getState().sessions.find((x) => x.id === active.id)?.messages ?? [];
    setMessages(finalMsgs);
    setRtTakes({});
    setRtHost("");
    setRtBusy(false);
  };

  // 圆桌发言的实时引用（供主持人使用）
  void rtTakes;

  const newChat = () => {
    setActiveId(null);
    setMessages([]);
    setPicking(true);
  };

  /* ---- 自定义智能体锻造 ---- */
  const [forgeOpen, setForgeOpen] = useState(false);
  const [forgeName, setForgeName] = useState("");
  const [forgeHint, setForgeHint] = useState("");
  const [forging, setForging] = useState(false);
  const [forged, setForged] = useState<null | {
    identityNote: string; name: string; tag: string; bio: string; color: string; system: string;
  }>(null);

  const forge = async () => {
    if (!forgeName.trim()) {
      toast.error("先告诉我要蒸馏谁");
      return;
    }
    setForging(true);
    setForged(null);
    try {
      const full = await streamChat({
        task: "persona-distill",
        args: { name: forgeName.trim(), hint: forgeHint.trim() },
        messages: [{ role: "user", content: `蒸馏：${forgeName.trim()}` }],
        temperature: 0.5,
        onDelta: () => {},
      });
      const p = personaDistillSchema.parse(extractJson(full));
      setForged({
        identityNote: p.identityNote,
        name: p.name,
        tag: p.tag,
        bio: p.bio,
        color: p.color || "violet",
        system: p.system,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "蒸馏失败，请重试");
    } finally {
      setForging(false);
    }
  };

  const saveForged = () => {
    if (!forged) return;
    const id = `custom:${uid("p")}`;
    addCustomPersona({
      id,
      name: forged.name,
      tag: forged.tag,
      bio: forged.bio,
      color: forged.color,
      identityNote: forged.identityNote,
      system: forged.system,
      createdAt: new Date().toISOString(),
    });
    toast.success(`「${forged.name}」已加入你的圆桌`);
    setForgeOpen(false);
    setForgeName("");
    setForgeHint("");
    setForged(null);
  };

  if (!hydrated) return <div className="h-40 animate-pulse rounded-2xl bg-surface/60" />;

  return (
    <div>
      <PageHeader
        icon={<Compass className="size-5" />}
        title="人生伙伴"
        desc="拿不定的事，问他们。他们不说客套话。"
        right={
          <Button variant="outline" onClick={newChat}>
            <Plus className="size-4" /> 新对话
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        {/* 会话列表 */}
        <Card className="h-fit lg:sticky lg:top-8">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-dim">
            对话记录
          </p>
          {sessions.length === 0 ? (
            <p className="text-xs text-ink-dim">还没有对话</p>
          ) : (
            <div className="space-y-1">
              {sessions.map((s) => {
                const p = resolvePersona(s.personaId);
                return (
                  <div
                    key={s.id}
                    className={cn(
                      "group flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs transition cursor-pointer",
                      activeId === s.id ? "bg-accent/[0.08] font-medium text-accent" : "text-ink-dim hover:bg-black/[0.04]"
                    )}
                    onClick={() => setActiveId(s.id)}
                  >
                    {s.personaId === "roundtable" ? (
                      <Users className="size-3.5 shrink-0" />
                    ) : (
                      <span className={cn("size-2 shrink-0 rounded-full", activeId === s.id ? "bg-accent" : "bg-black/20")} />
                    )}
                    <span className="truncate">{s.title}</span>
                    <button
                      className="ml-auto opacity-60 transition hover:text-bad cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeSession(s.id);
                        if (activeId === s.id) {
                          setActiveId(null);
                          setMessages([]);
                        }
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* 主区 */}
        <div className="min-w-0">
          {picking || (!active && !pending && !rtBusy) ? (
            <div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <button
                  onClick={() => startWith("roundtable")}
                  className="group rounded-2xl border border-accent/25 bg-accent/[0.04] p-5 text-left transition hover:border-accent/45 cursor-pointer sm:col-span-2 lg:col-span-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex size-11 items-center justify-center rounded-xl bg-[#1a1a1a]">
                      <Users className="size-5 text-white" />
                    </div>
                    <div>
                      <p className="font-bold text-ink">圆桌研讨会</p>
                      <p className="text-xs text-ink-dim">
                        每人独立发言，主持人收拢成纪要。
                      </p>
                    </div>
                  </div>
                </button>

                {/* 添加智能体 */}
                <button
                  onClick={() => setForgeOpen(true)}
                  className="flex min-h-[108px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-accent/35 bg-accent/[0.03] p-4 text-ink-dim transition hover:border-accent/60 hover:text-accent cursor-pointer"
                >
                  <UserPlus className="size-6" />
                  <span className="text-sm font-semibold">添加人物</span>
                  <span className="text-[11px]">说一个名字，蒸馏到本人降临</span>
                </button>

                {/* 自定义智能体 */}
                {customPersonas.map((c) => (
                  <div key={c.id} className="relative">
                    <button
                      onClick={() => startWith(c.id)}
                      className="w-full rounded-2xl border border-accent/25 bg-accent/[0.03] p-4 text-left transition hover:border-accent/45 hover:bg-accent/[0.05] cursor-pointer h-full"
                    >
                      <div className="flex items-center gap-2.5">
                        <PersonaAvatar id={c.id} name={c.name} className="size-9 text-sm" />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-ink">{c.name}</p>
                          <p className="text-[11px] text-ink-dim">{c.tag} · 自建</p>
                        </div>
                      </div>
                      <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-ink-dim">{c.bio}</p>
                    </button>
                    <button
                      onClick={() => {
                        removeCustomPersona(c.id);
                        toast.success(`已移除 ${c.name}`);
                      }}
                      className="absolute right-2 top-2 rounded-lg p-1.5 text-ink-dim/60 hover:bg-bad/10 hover:text-bad cursor-pointer"
                      title="删除该人物"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}

                {PERSONAS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => startWith(p.id)}
                    className="group card-lift rounded-2xl border border-border bg-white p-4 text-left transition hover:border-accent/40 cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5">
                      <PersonaAvatar id={p.id} name={p.name} className="size-9 text-sm" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-ink">{p.name}</p>
                        <p className="text-[11px] text-ink-dim">{p.tag}</p>
                      </div>
                    </div>
                    <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-ink-dim">{p.bio}</p>
                  </button>
                ))}
              </div>

              <Card className="mt-6 border-warn/25 bg-warn/[0.05]">
                <p className="flex items-center gap-2 text-sm font-bold text-warn">
                  <Zap className="size-4" /> 规矩只有一条
                </p>
                <p className="mt-2 text-xs leading-relaxed text-ink-dim">
                  第一句就是判断，没有「取决于」。你错，他们直说。
                </p>
              </Card>
            </div>
          ) : (
            <>
              <Card className="mb-4 flex items-center gap-3">
                {isRoundtable ? (
                  <>
                    <div className="flex size-10 items-center justify-center rounded-xl bg-[#1a1a1a]">
                      <Users className="size-5 text-white" />
                    </div>
                    <div>
                      <p className="font-bold text-ink">圆桌研讨会</p>
                      <p className="text-xs text-ink-dim">
                        {(active?.participants ?? []).length} 位与会者全员独立发言 + 主持人纪要
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <PersonaAvatar id={persona?.id ?? ""} name={persona?.name ?? "?"} className="size-10 text-sm" />
                    <div>
                      <p className="font-bold text-ink">{persona?.name}</p>
                      <p className="text-xs text-ink-dim">{persona?.tag} · {persona?.bio}</p>
                    </div>
                  </>
                )}
              </Card>

              <div className="space-y-4">
                {messages.map((m) => (
                  <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                    {m.role === "user" ? (
                      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[#1a1a1a] px-4 py-2.5 text-sm text-white">
                        {m.content}
                      </div>
                    ) : (
                      <Card
                        className={cn(
                          "max-w-[92%] rounded-2xl rounded-bl-md py-4",
                          m.content.startsWith("## 圆桌纪要") && "border-accent/25 bg-accent/[0.04]"
                        )}
                      >
                        <Markdown text={m.content} />
                      </Card>
                    )}
                  </div>
                ))}
                {pending && !isRoundtable && (
                  <Card className="max-w-[92%] rounded-2xl rounded-bl-md py-4">
                    <Markdown text={pending} />
                    <span className="stream-cursor" />
                  </Card>
                )}

                {/* 圆桌并行发言（流式中） */}
                {isRoundtable && rtBusy && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(active?.participants ?? []).map((pid) => {
                      const p = resolvePersona(pid);
                      if (!p) return null;
                      const text = rtTakes[pid];
                      return (
                        <Card key={pid} className="py-3.5">
                          <p className="mb-1.5 text-xs font-bold text-accent">{p.name}</p>
                          {text ? (
                            <div className="text-sm text-ink-dim">
                              <Markdown text={text} />
                              <span className="stream-cursor" />
                            </div>
                          ) : (
                            <p className="text-xs text-ink-dim/60">思考中…</p>
                          )}
                        </Card>
                      );
                    })}
                    {rtHost && (
                      <Card className="border-accent/25 bg-accent/[0.04] py-3.5 sm:col-span-2">
                        <p className="mb-1.5 text-xs font-bold text-accent">主持人纪要（生成中）</p>
                        <Markdown text={rtHost} />
                        <span className="stream-cursor" />
                      </Card>
                    )}
                  </div>
                )}
                <div ref={bottomRef} />
              </div>

              <div className="sticky bottom-20 mt-4 md:bottom-4">
                <div className="flex gap-2">
                  <Input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && doSend()}
                    placeholder={
                      isRoundtable
                        ? "把问题扔到圆桌上…"
                        : persona
                          ? `向 ${persona.name} 抛出你的困惑、决策或焦虑…`
                          : "输入…"
                    }
                    disabled={streaming || rtBusy}
                  />
                  <Button onClick={doSend} loading={streaming || rtBusy} className="shrink-0">
                    发送
                  </Button>
                </div>
                <p className="mt-2 text-center text-[11px] text-ink-dim/70">
                  他们给判断，不是标准答案。最后拍板的还是你。
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 圆桌与会者选择 */}
      <Modal open={forgeRoundtableOpen} onClose={() => setForgeRoundtableOpen(false)} title="圆桌研讨会 · 选择与会者" wide>
        <p className="mb-3 text-sm text-ink-dim">默认全员参加。每位与会者独立发言，最后由主持人综合出纪要（发言人数越多耗时越久）。</p>
        <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-3">
          {allPersonaOptions.map((p) => {
            const checked = rtParticipants.includes(p.id);
            return (
              <button
                key={p.id}
                onClick={() =>
                  setRtParticipants((prev) =>
                    checked ? prev.filter((x) => x !== p.id) : [...prev, p.id]
                  )
                }
                className={cn(
                  "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-xs transition cursor-pointer",
                  checked ? "border-accent/30 bg-accent/[0.08] font-medium text-accent" : "border-border bg-white text-ink-dim hover:text-ink"
                )}
              >
                <PersonaAvatar id={p.id} name={p.name} className="size-6 rounded-lg text-[10px]" />
                <span className="truncate">{p.name}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex justify-between">
          <Button variant="ghost" onClick={() => setRtParticipants(allPersonaOptions.map((p) => p.id))}>
            全选
          </Button>
          <Button onClick={createRoundtable}>
            <Users className="size-4" /> 开始圆桌（{rtParticipants.length} 人）
          </Button>
        </div>
      </Modal>

      {/* 自定义智能体锻造 */}
      <Modal open={forgeOpen} onClose={() => { setForgeOpen(false); setForged(null); }} title="添加人物" wide>
        {!forged ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-dim">
              输入一个真实人物的名字（如「王阳明」「贝佐斯」「Jony Ive」），会先确认这是谁，再深度蒸馏：思想体系、真实原话、语言指纹、论敌立场——直到仿佛本人降临。
            </p>
            <Input
              placeholder="名字，如：王阳明"
              value={forgeName}
              onChange={(e) => setForgeName(e.target.value)}
            />
            <Input
              placeholder="补充线索（可选）：领域/时代/代表作，帮助认对人"
              value={forgeHint}
              onChange={(e) => setForgeHint(e.target.value)}
            />
            <div className="flex justify-end">
              <Button onClick={forge} loading={forging}>
                <FlaskConical className="size-4" /> 开始深度蒸馏
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <Card className="border-accent/25 bg-accent/[0.04]">
              <p className="text-xs font-semibold uppercase tracking-wider text-accent">身份确认</p>
              <p className="mt-1.5 text-sm text-ink">{forged.identityNote}</p>
              <p className="mt-2 text-xs text-ink-dim">不是你想的那个人？改个更具体的名字或补充线索再试。</p>
            </Card>
            <div className="flex items-center gap-3">
              <PersonaAvatar id={forged.name} name={forged.name} className="size-11 text-base" />
              <div>
                <p className="font-bold text-ink">{forged.name}</p>
                <p className="text-xs text-ink-dim">{forged.tag} · {forged.bio}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setForged(null)}>重来</Button>
              <Button onClick={saveForged}>就是 TA，加入圆桌</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
