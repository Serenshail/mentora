/* ============================================================
 * 学习资源约束与校验（V26.1 P0）
 *
 * 用户明确提出的资源类型是硬约束，不是普通偏好（PRD §3.1）。
 * 三层：
 *   1. parseResourceConstraint：从用户话里解析硬约束（视频/中文/大陆可达/排除文档）
 *   2. classifyResource：按 URL 确定性分类（类型 + 大陆可访问性）——不靠模型自觉
 *   3. validateResources：生成后程序化校验——违规不崩溃，产出逐条标注 + 整体结论
 * ============================================================ */

export interface ResourceConstraint {
  /** video = 只要视频；any = 未声明 */
  resourceType: "video" | "any";
  language: "zh" | "any";
  /** mainland = 必须中国大陆可直接访问 */
  region: "mainland" | "any";
  excluded: string[];
}

export interface ResourceLike {
  title: string;
  url?: string | null;
  kind?: string;
}

export type ResourceAccess = "verified" | "accessible_with_conditions" | "unverified";

export interface ResourceVerdict extends ResourceLike {
  resType: "video" | "doc" | "other";
  access: ResourceAccess;
  /** 违反了哪条硬约束（空 = 合规） */
  violations: string[];
}

export function parseResourceConstraint(text: string): ResourceConstraint {
  const t = text || "";
  const notVideo = /不要视频|别要视频|不想要视频/.test(t);
  const wantsVideo = !notVideo && /视频/.test(t);
  const noDoc = /不要(给我)?(文档|文章|PDF|资料)|只要视频/.test(t);
  const zh = /中文|普通话|汉语/.test(t);
  const mainland = /大陆|国内|中国(大陆)?能(够)?(直接)?访问|不用翻墙|无墙/.test(t);
  const excluded: string[] = [];
  if (noDoc) excluded.push("documentation", "article");
  return {
    resourceType: wantsVideo || noDoc ? "video" : "any",
    language: zh ? "zh" : "any",
    region: mainland ? "mainland" : "any",
    excluded,
  };
}

/** URL 确定性分类：平台规则写死在这里，不信任模型的自述 */
export function classifyResource(r: ResourceLike): { resType: "video" | "doc" | "other"; access: ResourceAccess } {
  const url = (r.url || "").toLowerCase();
  const isBiliVideo = /bilibili\.com\/video\/bv/i.test(url);
  const isYoutube = /youtube\.com\/watch\?v=|youtu\.be\//.test(url);
  const isMooc = /icourse163\.org|xuetangx\.com|chinaedu|mooc/.test(url);
  const isDoc = /docs?\.|\/docs\/|documentation|developer\.|\.pdf$|github\.com\/.*\/(blob|readme)/i.test(url) || r.kind === "doc" || r.kind === "official";
  if (isBiliVideo) return { resType: "video", access: "verified" };
  if (isYoutube) return { resType: "video", access: "accessible_with_conditions" };
  if (isMooc) return { resType: "video", access: "verified" };
  if (isDoc) return { resType: "doc", access: /youtube/.test(url) ? "accessible_with_conditions" : "unverified" };
  if (/bilibili\.com/.test(url)) return { resType: "other", access: "accessible_with_conditions" };
  return { resType: r.kind === "course" ? "video" : "other", access: "unverified" };
}

export interface ValidationReport {
  ok: boolean;
  /** 硬约束被违反的条数 */
  violations: number;
  verdicts: ResourceVerdict[];
  /** 给模型/用户看的总结（中文） */
  summary: string;
}

/** 生成后程序化校验：违规不抛异常（PRD：不能直接让任务崩溃），
 *  产出逐条标注 + 违规计数 + 中文总结，由调用方决定降级/重试/如实告知。 */
export function validateResources(resources: ResourceLike[], c: ResourceConstraint): ValidationReport {
  const verdicts: ResourceVerdict[] = (resources || []).map((r) => {
    const { resType, access } = classifyResource(r);
    const violations: string[] = [];
    if (c.resourceType === "video" && resType !== "video") violations.push("用户要求视频，该条不是视频");
    if (c.region === "mainland" && access === "accessible_with_conditions")
      violations.push("中国大陆访问受限（YouTube 等），需说明或替换");
    if (c.language === "zh" && /english|英文教程|english course/i.test(`${r.title} ${r.url || ""}`))
      violations.push("用户要求中文资料");
    for (const ex of c.excluded) {
      if (ex === "documentation" && resType === "doc") violations.push("用户明确排除了文档类资料");
    }
    return { ...r, resType, access, violations };
  });
  const violations = verdicts.reduce((n, v) => n + (v.violations.length ? 1 : 0), 0);
  const ok = c.resourceType !== "video" || verdicts.some((v) => v.resType === "video" && v.violations.length === 0);
  const parts: string[] = [];
  if (c.resourceType === "video") {
    const videos = verdicts.filter((v) => v.resType === "video").length;
    parts.push(`资源类型约束=视频：${videos}/${verdicts.length} 条为视频`);
    if (videos === 0) parts.push("（没有找到可验证的视频——如实告知用户，不得用文档凑数）");
  }
  if (c.region === "mainland") {
    const blocked = verdicts.filter((v) => v.access === "accessible_with_conditions").length;
    if (blocked) parts.push(`${blocked} 条大陆访问受限，需标注或替换`);
  }
  return {
    ok,
    violations,
    verdicts,
    summary: parts.join("；") || "无硬约束，全部通过",
  };
}
