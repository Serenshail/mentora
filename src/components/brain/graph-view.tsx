"use client";

/* ============================================================
 * Obsidian 式力导向关系图谱（Canvas 版）
 *
 * 相比旧 SVG 版的关键升级：
 *   1. 滚轮缩放（以鼠标为中心）+ 空白拖拽平移 + 右下角缩放按钮 + 一键适应
 *   2. 网格分桶斥力（O(n·邻域)）+ alpha 冷却 —— 930+ 节点流畅，
 *      旧版 O(n²)/帧 + 每帧全量重渲是截图里「网格状卡死」的根因
 *   3. 标签随缩放级别显隐（zoom ≥ 0.75 全显，hover 邻居常显）
 *   4. 未解析链接（unresolved）画灰色虚线虚影，与 Obsidian 一致
 *   5. 稳定后停止重绘（CPU 归零），交互/数据变化自动唤醒
 * ============================================================ */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import { toast } from "sonner";
import { Link2 } from "lucide-react";
import type { KnowledgeItem } from "@/lib/types";

interface SimNode {
  id: string;
  title: string;
  domain: string;
  degree: number;
  unresolved: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const WORLD = 1400; // 初始布局半径参考（世界坐标无边界，可无限平移）

function domainColor(domain: string): string {
  const palette = ["#5b54e6", "#0e7490", "#047857", "#b45309", "#9f1239", "#475569"];
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
void domainColor; // 已改为 Obsidian 单色系，保留以防后续需要

export function GraphView({
  notes,
  onOpen,
  focusId,
}: {
  notes: KnowledgeItem[];
  onOpen: (id: string) => void;
  /** 打开图谱时把镜头居中到这篇笔记(及其邻居),避免用户进来面对空图自己找 */
  focusId?: string | null;
}) {
  const [gQuery, setGQuery] = useState("");
  const [gDomain, setGDomain] = useState("all");
  const [showOrphans, setShowOrphans] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  const gDomains = useMemo(
    () => Array.from(new Set(notes.map((n) => n.domain.split("/")[0]))).sort(),
    [notes]
  );

  const visibleNotes = useMemo(() => {
    const q = gQuery.trim().toLowerCase();
    return notes.filter((n) => {
      if (gDomain !== "all" && n.domain.split("/")[0] !== gDomain) return false;
      if (!q) return true;
      return n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q);
    });
  }, [notes, gQuery, gDomain]);

  const edgeList = useMemo(() => {
    const idSet = new Set(visibleNotes.map((n) => n.id));
    const seen = new Set<string>();
    const out: { a: string; b: string }[] = [];
    for (const n of visibleNotes) {
      for (const l of n.links) {
        if (!idSet.has(l) || l === n.id) continue;
        const key = n.id < l ? `${n.id}|${l}` : `${l}|${n.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ a: n.id, b: l });
      }
    }
    return out;
  }, [visibleNotes]);

  const orphanIds = useMemo(() => {
    const linked = new Set<string>();
    for (const n of visibleNotes) for (const l of n.links) linked.add(l);
    return new Set(visibleNotes.filter((n) => n.links.length === 0 && !linked.has(n.id)).map((n) => n.id));
  }, [visibleNotes]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<{ a: string; b: string }[]>([]);
  const camRef = useRef({ x: 0, y: 0, zoom: 1 }); // 相机：世界坐标偏移 + 缩放
  const hoverRef = useRef<string | null>(null);
  const dragNodeRef = useRef<string | null>(null);
  const panRef = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  const alphaRef = useRef(1);
  const dirtyRef = useRef(true);
  const sizeRef = useRef({ w: 920, h: 560 });
  const countsRef = useRef({ nodes: 0, edges: 0 });
  /* v17：HUD 展示值（节点/边计数、缩放百分比）从"渲染期读 ref"迁到 state。
   * React Compiler 禁止渲染读 ref——此前 zoom% 标签读 camRef，滚轮缩放时不会重渲染，
   * 显示是坏的（forceRender 黑客只覆盖数据变化，覆盖不到相机变化）。
   * 规则同时禁止 effect 同步 setState：统一走 rAF 一拍后同步。 */
  const [viewStats, setViewStats] = useState({ zoom: 100, nodes: 0, edges: 0 });
  const syncStats = useCallback(() => {
    requestAnimationFrame(() =>
      setViewStats({
        zoom: Math.round(camRef.current.zoom * 100),
        nodes: countsRef.current.nodes,
        edges: countsRef.current.edges,
      })
    );
  }, []);

  /* ---- 数据 → 仿真节点（保留旧位置，新增节点螺旋散布） ---- */
  useEffect(() => {
    edgesRef.current = edgeList;
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const degree = new Map<string, number>();
    for (const e of edgeList) {
      degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
      degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
    }
    let i = 0;
    nodesRef.current = visibleNotes.map((n) => {
      const old = prev.get(n.id);
      i += 1;
      const angle = i * 2.399963; // 黄金角螺旋，初始散布均匀
      const rad = 30 + Math.sqrt(i) * 14;
      return {
        id: n.id,
        title: n.title,
        domain: n.domain,
        unresolved: Boolean(n.unresolved),
        degree: degree.get(n.id) ?? 0,
        x: old?.x ?? WORLD / 2 + Math.cos(angle) * rad,
        y: old?.y ?? WORLD / 2 + Math.sin(angle) * rad,
        vx: 0,
        vy: 0,
      };
    });
    countsRef.current = { nodes: nodesRef.current.length, edges: edgeList.length };
    alphaRef.current = 1;
    dirtyRef.current = true;
    syncStats();
  }, [visibleNotes, edgeList, syncStats]);

  /* ---- 主循环：物理（网格分桶）+ 按需渲染 ---- */
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let running = true;

    const byId = () => {
      const m = new Map<string, SimNode>();
      for (const n of nodesRef.current) m.set(n.id, n);
      return m;
    };

    const physics = () => {
      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      if (nodes.length === 0) return;
      const alpha = alphaRef.current;

      /* 斥力：网格分桶，只和邻近格子里的节点相互作用 */
      const CELL = 130;
      const grid = new Map<string, SimNode[]>();
      for (const n of nodes) {
        const key = `${Math.floor(n.x / CELL)},${Math.floor(n.y / CELL)}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(n);
        else grid.set(key, [n]);
      }
      const REP = 1400 * alpha;
      for (const n of nodes) {
        const cx = Math.floor(n.x / CELL);
        const cy = Math.floor(n.y / CELL);
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          for (let gy = cy - 1; gy <= cy + 1; gy++) {
            const bucket = grid.get(`${gx},${gy}`);
            if (!bucket) continue;
            for (const o of bucket) {
              if (o.id <= n.id) continue;
              let dx = n.x - o.x, dy = n.y - o.y;
              let d2 = dx * dx + dy * dy;
              if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
              if (d2 > CELL * CELL * 2) continue;
              const d = Math.sqrt(d2);
              const f = Math.min(REP / d2, 3) / d;
              const fx = dx * f, fy = dy * f;
              n.vx += fx; n.vy += fy;
              o.vx -= fx; o.vy -= fy;
            }
          }
        }
      }

      /* 弹簧：相连节点靠拢 */
      const map = byId();
      for (const e of edges) {
        const a = map.get(e.a), b = map.get(e.b);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const rest = 95;
        const f = ((d - rest) / d) * 0.055 * alpha;
        const fx = dx * f, fy = dy * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }

      /* 向心 + 阻尼 + 积分（无边界夹持——世界无限，靠缩放看全貌） */
      const cx = WORLD / 2, cy = WORLD / 2;
      for (const n of nodes) {
        if (dragNodeRef.current === n.id) { n.vx = 0; n.vy = 0; continue; }
        n.vx += (cx - n.x) * 0.002 * alpha;
        n.vy += (cy - n.y) * 0.002 * alpha;
        n.vx *= 0.85; n.vy *= 0.85;
        n.x += Math.max(-9, Math.min(9, n.vx));
        n.y += Math.max(-9, Math.min(9, n.vy));
      }
      alphaRef.current = alpha * 0.99;
    };

    const render = () => {
      const { w, h } = sizeRef.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#fcfcfd";
      ctx.fillRect(0, 0, w, h);

      const cam = camRef.current;
      const zoom = cam.zoom;
      const toScreen = (x: number, y: number): [number, number] => [
        (x - cam.x) * zoom + w / 2,
        (y - cam.y) * zoom + h / 2,
      ];

      const hover = hoverRef.current;
      let neighborSet: Set<string> | null = null;
      if (hover) {
        neighborSet = new Set([hover]);
        for (const e of edgesRef.current) {
          if (e.a === hover) neighborSet.add(e.b);
          if (e.b === hover) neighborSet.add(e.a);
        }
      }

      /* 边 */
      const map = new Map(nodesRef.current.map((n) => [n.id, n]));
      for (const e of edgesRef.current) {
        const a = map.get(e.a), b = map.get(e.b);
        if (!a || !b) continue;
        const active = !neighborSet || (neighborSet.has(e.a) && neighborSet.has(e.b));
        ctx.beginPath();
        ctx.moveTo(...toScreen(a.x, a.y));
        ctx.lineTo(...toScreen(b.x, b.y));
        ctx.strokeStyle = active ? (hover ? "#8a8a92" : "#c9c9cf") : "#e4e4e9";
        ctx.lineWidth = (active ? 1.3 : 0.8) * Math.max(0.5, zoom);
        ctx.stroke();
      }

      /* 节点 */
      const showLabels = zoom >= 0.75 || nodesRef.current.length < 80;
      for (const n of nodesRef.current) {
        if (dragNodeRef.current && dragNodeRef.current !== n.id) { /* 拖拽中仍全量绘制 */ }
        const active = !neighborSet || neighborSet.has(n.id);
        const [sx, sy] = toScreen(n.x, n.y);
        if (sx < -40 || sy < -40 || sx > w + 40 || sy > h + 40) continue; // 视口裁剪
        const r = (n.unresolved ? 4.5 : 6 + Math.min(13, Math.sqrt(n.degree) * 2.6)) * zoom;
        const x = sx, y = sy;
        ctx.globalAlpha = active ? 1 : 0.15;
        if (n.unresolved) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.strokeStyle = "#b6b6bd";
          ctx.setLineDash([2.5, 2.5]);
          ctx.lineWidth = 1.2 * Math.max(0.5, zoom);
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          /* Obsidian 单色系：连接越多越黑，无彩色 */
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          const t = Math.min(1, n.degree / 8); // 0 孤立 → 1枢纽
          ctx.fillStyle = t > 0.5 ? "#232326" : t > 0.15 ? "#55555c" : "#8f8f96";
          ctx.fill();
          if (hover === n.id) {
            ctx.strokeStyle = "#1a1a1a";
            ctx.lineWidth = 1.6;
            ctx.stroke();
          }
        }
        /* 标签：缩放足够大，或 hover/邻居时 */
        if (showLabels || (neighborSet && neighborSet.has(n.id))) {
          const label = n.title.length > 14 ? n.title.slice(0, 14) + "…" : n.title;
          ctx.font = `${11 * Math.max(0.85, zoom)}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.fillStyle = hover === n.id ? "#1a1a1a" : active ? "#77777d" : "#c4c4ca";
          ctx.fillText(label, x, y + r + 12 * Math.max(0.85, zoom));
        }
        ctx.globalAlpha = 1;
      }
    };

    const loop = () => {
      if (!running) return;
      const needsPhysics = alphaRef.current > 0.02 || dragNodeRef.current;
      if (needsPhysics) {
        physics();
        physics(); // 每帧两步，收敛更快
        dirtyRef.current = true;
      }
      if (dirtyRef.current) {
        dirtyRef.current = false;
        render();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(raf); };
  }, []);

  /* ---- 尺寸自适应 ---- */
  useEffect(() => {
    const wrap = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const canvas = canvasRef.current;
      if (!wrapRef.current || !canvas) return; // 卸载竞态：节点已移除时不再读 style
      const r = wrapRef.current.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      dirtyRef.current = true;
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  /* 没有焦点笔记时(如从侧栏直接进图谱),自动 fitView 让全图入视野,避免"打开是空的" */
  useEffect(() => {
    if (focusId) return;
    const t = setTimeout(() => {
      fitView();
      dirtyRef.current = true;
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, notes.length]);

  /* 打开图谱时把镜头居中到 focusId 笔记(等物理布局稳定后),用户一眼看到它的关系网 */
  useEffect(() => {
    if (!focusId) return;
    let tries = 0;
    const iv = setInterval(() => {
      const n = nodesRef.current.find((x) => x.id === focusId);
      if (n) {
        camRef.current = { x: n.x, y: n.y, zoom: 1.35 };
        syncStats();
        dirtyRef.current = true;
        if (++tries > 2) clearInterval(iv);
      } else if (++tries > 20) {
        clearInterval(iv);
      }
    }, 120);
    return () => clearInterval(iv);
  }, [focusId]);

  /* 滚轮缩放要阻止页面滚动，但 React 的 onWheel 是 passive 的，preventDefault 会告警；
   * 故用原生非 passive 监听单独拦截默认滚动，onWheel 只算缩放数学。 */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const block = (e: WheelEvent) => e.preventDefault();
    cv.addEventListener("wheel", block, { passive: false });
    return () => cv.removeEventListener("wheel", block);
  }, []);

  /* ---- 相机与交互 ---- */
  const screenToWorld = (sx: number, sy: number) => {
    const { w, h } = sizeRef.current;
    const cam = camRef.current;
    return { x: (sx - w / 2) / cam.zoom + cam.x, y: (sy - h / 2) / cam.zoom + cam.y };
  };

  const pickNode = (sx: number, sy: number): SimNode | null => {
    const { x, y } = screenToWorld(sx, sy);
    const pad = 8 / camRef.current.zoom;
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const n = nodesRef.current[i];
      const r = n.unresolved ? 4.5 : 6 + Math.min(13, Math.sqrt(n.degree) * 2.6);
      const dx = n.x - x, dy = n.y - y;
      if (dx * dx + dy * dy <= (r + pad) * (r + pad)) return n;
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const node = pickNode(sx, sy);
    if (node) {
      dragNodeRef.current = node.id;
      alphaRef.current = Math.max(alphaRef.current, 0.35);
    } else {
      panRef.current = { sx, sy, cx: camRef.current.x, cy: camRef.current.y };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

    if (panRef.current) {
      camRef.current.x = panRef.current.cx - (sx - panRef.current.sx) / camRef.current.zoom;
      camRef.current.y = panRef.current.cy - (sy - panRef.current.sy) / camRef.current.zoom;
      dirtyRef.current = true;
      return;
    }
    if (dragNodeRef.current) {
      const n = nodesRef.current.find((nn) => nn.id === dragNodeRef.current);
      if (n) {
        const { x, y } = screenToWorld(sx, sy);
        n.x = x; n.y = y;
        dirtyRef.current = true;
      }
      return;
    }
    const node = pickNode(sx, sy);
    if (node?.id !== hoverRef.current) {
      hoverRef.current = node?.id ?? null;
      e.currentTarget.style.cursor = node ? "grab" : "default";
      dirtyRef.current = true;
    }
  };

  const onPointerUp = () => {
    dragNodeRef.current = null;
    panRef.current = null;
    alphaRef.current = Math.max(alphaRef.current, 0.12);
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const cam = camRef.current;
    const world = screenToWorld(sx, sy);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    cam.zoom = Math.max(0.06, Math.min(5, cam.zoom * factor));
    /* 保证鼠标下的世界点不动 */
    cam.x = world.x - (sx - sizeRef.current.w / 2) / cam.zoom;
    cam.y = world.y - (sy - sizeRef.current.h / 2) / cam.zoom;
    dirtyRef.current = true;
    syncStats();
  };

  const zoomBy = (factor: number) => {
    const cam = camRef.current;
    cam.zoom = Math.max(0.06, Math.min(5, cam.zoom * factor));
    dirtyRef.current = true;
    syncStats();
  };

  function fitView() {
    const nodes = nodesRef.current;
    if (nodes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y);
    }
    const { w, h } = sizeRef.current;
    const pad = 60;
    camRef.current.zoom = Math.max(0.06, Math.min(2.5,
      Math.min((w - pad * 2) / Math.max(1, maxX - minX), (h - pad * 2) / Math.max(1, maxY - minY))
    ));
    camRef.current.x = (minX + maxX) / 2;
    camRef.current.y = (minY + maxY) / 2;
    dirtyRef.current = true;
    syncStats();
  }

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const node = pickNode(e.clientX - rect.left, e.clientY - rect.top);
    if (node) onOpen(node.id);
  };

  const rebuild = () => {
    if (rebuilding) return;
    if (!confirm("扫描全部笔记正文，重建 [[双链]] 关系？\n\n解析不到目标标题的链接会建成「未解析链接」占位笔记（Obsidian 同款行为）；已有人工/AI 建立的链接保留。")) return;
    setRebuilding(true);
    try {
      const r = useAppStore.getState().rebuildLinks();
      toast.success(`关系链重建完成：更新 ${r.touched} 篇，新建未解析占位 ${r.placeholders} 篇`);
      alphaRef.current = 1;
      dirtyRef.current = true;
    } catch {
      toast.error("重建失败，稍后再试");
    } finally {
      setRebuilding(false);
    }
  };

  const shownCount = showOrphans ? viewStats.nodes : visibleNotes.filter((n) => !orphanIds.has(n.id)).length;

  return (
    <div className="relative" ref={wrapRef}>
      {/* Obsidian 式右上角控制面板 */}
      <div className="absolute right-3 top-3 z-10 w-56 rounded-xl border border-border bg-white/95 p-2.5 shadow-sm backdrop-blur">
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-dim/70">图谱过滤</p>
          <button
            onClick={() => setPanelOpen((v) => !v)}
            className="text-[10.5px] text-accent hover:underline cursor-pointer"
          >
            {panelOpen ? "收起" : "展开"}
          </button>
        </div>
        {panelOpen ? (
          <div className="space-y-2">
            <input
              className="w-full rounded-lg border border-border bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-accent/50"
              placeholder="搜索笔记标题/正文…"
              value={gQuery}
              onChange={(e) => setGQuery(e.target.value)}
            />
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setGDomain("all")}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10.5px] cursor-pointer",
                  gDomain === "all"
                    ? "border-accent/40 bg-accent/[0.1] font-semibold text-accent"
                    : "border-border bg-white text-ink-dim hover:text-ink"
                )}
              >
                全部目录
              </button>
              {gDomains.map((d) => (
                <button
                  key={d}
                  onClick={() => setGDomain(gDomain === d ? "all" : d)}
                  className={cn(
                    "max-w-full truncate rounded-full border px-2 py-0.5 text-[10.5px] cursor-pointer",
                    gDomain === d
                      ? "border-accent/40 bg-accent/[0.1] font-semibold text-accent"
                      : "border-border bg-white text-ink-dim hover:text-ink"
                  )}
                >
                  {d}
                </button>
              ))}
            </div>
            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-dim">
              <input
                type="checkbox"
                checked={showOrphans}
                onChange={(e) => setShowOrphans(e.target.checked)}
                className="size-3 accent-[#6c5ce7]"
              />
              显示孤立节点（无连接）
            </label>
            <button
              onClick={rebuild}
              disabled={rebuilding}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-white px-2 py-1.5 text-[11.5px] text-ink-dim transition hover:border-accent/40 hover:text-accent cursor-pointer disabled:opacity-50"
              title="扫描全部笔记正文里的 [[双链]]，重建导入时丢失的关系；解析不到的目标建成灰色占位笔记"
            >
              <Link2 className="size-3.5" />
              {rebuilding ? "重建中…" : "重建关系链（修复导入丢失）"}
            </button>
          </div>
        ) : (
          <p className="text-[10.5px] text-ink-dim/70">
            {shownCount} 节点 · {viewStats.edges} 连接
          </p>
        )}
      </div>

      {/* 右下角缩放控件（Obsidian 同款） */}
      <div className="absolute bottom-3 right-3 z-10 flex overflow-hidden rounded-lg border border-border bg-white/95 shadow-sm backdrop-blur">
        <button onClick={() => zoomBy(1 / 1.3)} title="缩小" className="px-2.5 py-1.5 text-sm text-ink-dim hover:bg-black/[0.04] hover:text-ink cursor-pointer">−</button>
        <button onClick={() => { camRef.current.zoom = 1; dirtyRef.current = true; syncStats(); }} title="重置缩放" aria-label={`重置缩放为 100%，当前 ${viewStats.zoom}%`} className="border-x border-border px-2.5 py-1.5 text-[11px] tabular text-ink-dim hover:bg-black/[0.04] hover:text-ink cursor-pointer">
          {viewStats.zoom}%
        </button>
        <button onClick={() => zoomBy(1.3)} title="放大" className="px-2.5 py-1.5 text-sm text-ink-dim hover:bg-black/[0.04] hover:text-ink cursor-pointer">+</button>
        <button onClick={fitView} title="适应全图" className="border-l border-border px-2.5 py-1.5 text-[11px] text-ink-dim hover:bg-black/[0.04] hover:text-ink cursor-pointer">适应</button>
      </div>

      <canvas
        ref={canvasRef}
        className="block w-full cursor-default touch-none rounded-2xl border border-border bg-[#fcfcfd]"
        style={{ height: "calc(100vh - 170px)", minHeight: 480 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { hoverRef.current = null; onPointerUp(); }}
        onClick={onClick}
        onWheel={onWheel}
        onDoubleClick={fitView}
      />
      {visibleNotes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-ink-dim/60">
            {notes.length === 0 ? "笔记还不够多——先积累几条，图谱会长出来" : "没有匹配的笔记"}
          </p>
        </div>
      )}
    </div>
  );
}
