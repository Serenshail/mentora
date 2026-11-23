"use client";

import { useEffect, useState } from "react";

/**
 * 页脚运行标识（T-ICT-032）：只读展示 `/api/health` 返回的 `build`。
 * 与健康检查同源，便于把「打开的页面」与「实际运行的镜像/提交」对应起来。
 * 失败或未返回值时不渲染，不影响任何页面功能。
 */
export function BuildBadge() {
  const [build, setBuild] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { build?: unknown }) => {
        if (!cancelled && typeof j.build === "string" && j.build.length > 0) setBuild(j.build);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!build) return null;
  return (
    <p className="select-all px-1 pt-2 text-[11px] leading-relaxed text-ink-dim/70" title="与 /api/health 的 build 字段同源">
      运行标识 {build.slice(0, 12)}
    </p>
  );
}