"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Input, PageHeader } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { useAppStore } from "@/lib/store";
import { useChat, useHydrated } from "@/lib/use-chat";
import { PERSONAS, ROUNDTABLE_SYSTEM, personaById } from "@/lib/ai/prompts";
import { cn, uid } from "@/lib/utils";
import { toast } from "sonner";
import { Compass, Plus, Trash2, Users, Zap } from "lucide-react";

export default function CouncilPage() {
  const hydrated = useHydrated();
  const sessions = useAppStore((s) => s.sessions);
  const addSession = useAppStore((s) => s.addSession);
  const addSessionMsg = useAppStore((s) => s.addSessionMsg);
  const removeSession = useAppStore((s) => s.removeSession);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const { messages, setMessages, pending, streaming, send } = useChat();
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const persona = active ? personaById(active.personaId) : undefined;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending]);

  useEffect(() => {
    if (active) setMessages(active.messages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const startWith = async (personaId: string) => {
    setPicking(false);
    const p = personaById(personaId);
    const sessionId = uid("sess");
    addSession({
      id: sessionId,
      personaId,
      title: p ? p.name : "圆桌会议",
      messages: [],
      createdAt: new Date().toISOString(),
    });
    setActiveId(sessionId);
    setMessages([]);
    // 开场白由模型生成一句符合 persona 风格的自我立场
    await send({
      system: p ? p.system : ROUNDTABLE_SYSTEM(PERSONAS.map((x) => x.name).join("、")),
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

  const doSend = () => {
    const text = input.trim();
    if (!text || streaming || !active) return;
    setInput("");
    const base = active.messages; // 不含本条
    const userMsg = { id: uid("m"), role: "user" as const, content: text, at: new Date().toISOString() };
    addSessionMsg(active.id, userMsg);
    void send({
      system: persona ? persona.system : ROUNDTABLE_SYSTEM(PERSONAS.map((x) => x.name).join("、")),
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

  const newChat = () => {
    setActiveId(null);
    setMessages([]);
    setPicking(true);
  };

  if (!hydrated) return <div className="h-40 animate-pulse rounded-2xl bg-surface/60" />;

  return (
    <div>
      <PageHeader
        icon={<Compass className="size-5" />}
        title="人生伙伴"
        desc="高认知的思想伙伴：不迎合、不安慰式敷衍。12 位智者的思维方式 + 圆桌模式，给你自己的判断。"
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
                const p = personaById(s.personaId);
                return (
                  <div
                    key={s.id}
                    className={cn(
                      "group flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs transition cursor-pointer",
                      activeId === s.id ? "bg-accent/15 text-white" : "text-ink-dim hover:bg-white/5"
                    )}
                    onClick={() => setActiveId(s.id)}
                  >
                    {s.personaId === "roundtable" ? (
                      <Users className="size-3.5 shrink-0" />
                    ) : (
                      <span className={cn("size-2 shrink-0 rounded-full bg-gradient-to-br", p?.color)} />
                    )}
                    <span className="truncate">{s.title}</span>
                    <button
                      className="ml-auto opacity-0 transition group-hover:opacity-100 hover:text-bad cursor-pointer"
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
          {picking || (!active && !pending) ? (
            <div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <button
                  onClick={() => startWith("roundtable")}
                  className="group rounded-2xl border border-accent/40 bg-gradient-to-br from-accent/15 to-cyan-500/10 p-5 text-left transition hover:border-accent/70 cursor-pointer sm:col-span-2 lg:col-span-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-[#7c6cff] to-[#22d3ee]">
                      <Users className="size-5 text-white" />
                    </div>
                    <div>
                      <p className="font-bold text-white">圆桌会议</p>
                      <p className="text-xs text-ink-dim">
                        把问题同时扔给多位导师：共同判断 + 分歧现场 + 合成建议
                      </p>
                    </div>
                  </div>
                </button>
                {PERSONAS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => startWith(p.id)}
                    className="group rounded-2xl border border-border bg-surface/70 p-4 text-left transition hover:border-accent/50 hover:bg-surface-2 cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5">
                      <div
                        className={cn(
                          "flex size-9 items-center justify-center rounded-xl bg-gradient-to-br text-sm font-black text-white",
                          p.color
                        )}
                      >
                        {p.name.slice(0, 1)}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-white">{p.name}</p>
                        <p className="text-[11px] text-ink-dim">{p.tag}</p>
                      </div>
                    </div>
                    <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-ink-dim">
                      {p.bio}
                    </p>
                  </button>
                ))}
              </div>

              <Card className="mt-6 border-warn/30 bg-warn/5">
                <p className="flex items-center gap-2 text-sm font-bold text-warn">
                  <Zap className="size-4" /> 这里的对话有一条铁律
                </p>
                <p className="mt-2 text-xs leading-relaxed text-ink-dim">
                  第一句话就是明确判断，没有「取决于」「各有道理」；它会主动给出你观点的最强反方；
                  不知道就说不知道；情绪问题会被翻译成可分析、可执行的问题。它不负责哄你开心，负责让你变清醒。
                </p>
              </Card>
            </div>
          ) : (
            <>
              <Card className="mb-4 flex items-center gap-3">
                {persona ? (
                  <>
                    <div
                      className={cn(
                        "flex size-10 items-center justify-center rounded-xl bg-gradient-to-br text-sm font-black text-white",
                        persona.color
                      )}
                    >
                      {persona.name.slice(0, 1)}
                    </div>
                    <div>
                      <p className="font-bold text-white">{persona.name}</p>
                      <p className="text-xs text-ink-dim">{persona.tag} · {persona.bio}</p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#7c6cff] to-[#22d3ee]">
                      <Users className="size-5 text-white" />
                    </div>
                    <div>
                      <p className="font-bold text-white">圆桌会议</p>
                      <p className="text-xs text-ink-dim">多位导师共同审视你的问题</p>
                    </div>
                  </>
                )}
              </Card>

              <div className="space-y-4">
                {messages.map((m) => (
                  <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                    {m.role === "user" ? (
                      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent/20 border border-accent/30 px-4 py-2.5 text-sm">
                        {m.content}
                      </div>
                    ) : (
                      <Card className="max-w-[92%] rounded-2xl rounded-bl-md py-4">
                        <Markdown text={m.content} />
                      </Card>
                    )}
                  </div>
                ))}
                {pending && (
                  <Card className="max-w-[92%] rounded-2xl rounded-bl-md py-4">
                    <Markdown text={pending} />
                    <span className="stream-cursor" />
                  </Card>
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
                      persona
                        ? `向 ${persona.name} 抛出你的困惑、决策或焦虑…`
                        : "把你的问题扔到圆桌上…"
                    }
                    disabled={streaming}
                  />
                  <Button onClick={doSend} loading={streaming} className="shrink-0">
                    发送
                  </Button>
                </div>
                <p className="mt-2 text-center text-[11px] text-ink-dim/70">
                  它给的是判断，不是 Standard Answer —— 重要决策请保留自己的最终裁量
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
