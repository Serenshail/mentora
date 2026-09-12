"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeItem } from "@/lib/types";

interface SimNode {
  id: string;
  title: string;
  domain: string;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const W = 920;
const H = 560;

function domainColor(domain: string): string {
  /* 沉稳编辑级色板：去品红/亮紫（AI 感），统一低饱和 */
  const palette = ["#5b54e6", "#0e7490", "#047857", "#b45309", "#9f1239", "#475569"];
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

/** Obsidian 风格力导向关系图谱 */
export function GraphView({
  notes,
  onOpen,
}: {
  notes: KnowledgeItem[];
  onOpen: (id: string) => void;
}) {
  const [tick, setTick] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const edges = useMemo(() => {
    const ids = new Set(notes.map((n) => n.id));
    return notes.flatMap((n) =>
      n.links
        .filter((l) => ids.has(l))
        .map((l) => ({ from: n.id, to: l }))
    );
  }, [notes]);

  // 初始化节点
  useEffect(() => {
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    nodesRef.current = notes.map((n, i) => {
      const old = prev.get(n.id);
      const angle = (i / Math.max(1, notes.length)) * Math.PI * 2;
      return {
        id: n.id,
        title: n.title,
        domain: n.domain,
        degree: n.links.length,
        x: old?.x ?? W / 2 + Math.cos(angle) * 180,
        y: old?.y ?? H / 2 + Math.sin(angle) * 180,
        vx: 0,
        vy: 0,
      };
    });
    setTick((t) => t + 1);
  }, [notes]);

  // 力模拟
  useEffect(() => {
    let raf = 0;
    let running = true;
    const nodes = nodesRef.current;
    const idMap = new Map(nodes.map((n) => [n.id, n]));

    const step = () => {
      if (!running) return;
      // 斥力
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          const d = Math.sqrt(d2);
          const f = Math.min(2200 / d2, 4);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
      }
      // 弹簧（边）
      for (const e of edges) {
        const a = idMap.get(e.from), b = idMap.get(e.to);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const f = ((d - 110) / d) * 0.04;
        a.vx += dx * f; a.vy += dy * f;
        b.vx -= dx * f; b.vy -= dy * f;
      }
      // 向心 + 阻尼 + 积分
      for (const n of nodes) {
        n.vx += (W / 2 - n.x) * 0.0035;
        n.vy += (H / 2 - n.y) * 0.0035;
        if (dragRef.current?.id === n.id) { n.vx = 0; n.vy = 0; continue; }
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += Math.max(-6, Math.min(6, n.vx));
        n.y += Math.max(-6, Math.min(6, n.vy));
        n.x = Math.max(46, Math.min(W - 46, n.x));
        n.y = Math.max(30, Math.min(H - 30, n.y));
      }
      setTick((t) => t + 1);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { running = false; cancelAnimationFrame(raf); };
  }, [edges]);

  const neighborSet = useMemo(() => {
    if (!hover) return null;
    const set = new Set<string>([hover]);
    for (const e of edges) {
      if (e.from === hover) set.add(e.to);
      if (e.to === hover) set.add(e.from);
    }
    return set;
  }, [hover, edges]);

  const toLocal = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * W, y: ((e.clientY - rect.top) / rect.height) * H };
  };

  void tick; // 触发重渲

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full rounded-2xl border border-border bg-[#fcfcfd] touch-none"
      style={{ height: 560 }}
      onPointerMove={(e) => {
        if (!dragRef.current) return;
        const { x, y } = toLocal(e);
        const n = nodesRef.current.find((nn) => nn.id === dragRef.current!.id);
        if (n) { n.x = x; n.y = y; }
      }}
      onPointerUp={() => { dragRef.current = null; }}
      onPointerLeave={() => { dragRef.current = null; }}
    >
      {/* 边 */}
      {edges.map((e, i) => {
        const a = nodesRef.current.find((n) => n.id === e.from);
        const b = nodesRef.current.find((n) => n.id === e.to);
        if (!a || !b) return null;
        const active = !neighborSet || (neighborSet.has(e.from) && neighborSet.has(e.to));
        return (
          <line
            key={i}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={active ? "#b9b4ee" : "#e9e9ec"}
            strokeWidth={active ? 1.4 : 1}
          />
        );
      })}
      {/* 节点 */}
      {nodesRef.current.map((n) => {
        const r = 7 + Math.min(10, n.degree * 2.4);
        const active = !neighborSet || neighborSet.has(n.id);
        return (
          <g
            key={n.id}
            transform={`translate(${n.x},${n.y})`}
            style={{ cursor: "grab", opacity: active ? 1 : 0.25 }}
            onPointerDown={(e) => {
              e.preventDefault();
              const { x, y } = toLocal(e);
              dragRef.current = { id: n.id, offsetX: n.x - x, offsetY: n.y - y };
            }}
            onClick={() => onOpen(n.id)}
            onPointerEnter={() => setHover(n.id)}
            onPointerLeave={() => setHover(null)}
          >
            <circle r={r} fill={domainColor(n.domain)} stroke={hover === n.id ? "#1a1a1a" : "none"} strokeWidth={2} />
            <text
              y={r + 13}
              textAnchor="middle"
              fontSize={11}
              fill={hover === n.id ? "#1a1a1a" : "#6e6e73"}
              style={{ pointerEvents: "none", userSelect: "none" }}
            >
              {n.title.length > 12 ? n.title.slice(0, 12) + "…" : n.title}
            </text>
          </g>
        );
      })}
      {notes.length === 0 && (
        <text x={W / 2} y={H / 2} textAnchor="middle" fill="#a1a1aa" fontSize={14}>
          笔记还不够多——先积累几条，图谱会长出来
        </text>
      )}
    </svg>
  );
}
