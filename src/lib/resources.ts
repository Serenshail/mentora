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

/* 否定式视频约束：「不要视频」的否定词与「视频」之间常被推荐/指代类词隔开
 * （「别推荐视频」「不要给我找视频」），旧正则只认三种紧邻写法，这些说法会被
 * 误判成「只要视频」——与用户意图相反。
 * 这里用线性扫描而不是「否定词 + 填充词重复 + 视频」的正则：后者是嵌套量词，
 * 遇到「不要 + 推荐推荐推荐…」这类用户输入会回溯爆炸（ReDoS），
 * 而 constraintText 来自模型转述的用户原话，属于不可信输入。
 * 填充词每个最多消费一次且总数有上限，整体 O(n)。 */
const NEG_VIDEO_PREFIXES = ["不想要", "不需要", "不希望", "不要", "不想", "不用", "别"];
const NEG_VIDEO_FILLERS = [
  "给我", "帮我", "推荐", "找", "搜", "提供", "看到", "看", "再", "要",
  "任何", "一些", "些", "多", "其他", "别的", "的",
];
/** 「特别/分别/区别/类别/识别…」里的「别」不是否定词 */
const NOT_A_NEG_PREFIX_CHARS = "特别分告区类个性级派识鉴差离辨甄隔";

function hasNegatedVideo(t: string): boolean {
  for (let i = 0; i < t.length; i++) {
    const prefix = NEG_VIDEO_PREFIXES.find((w) => t.startsWith(w, i));
    if (!prefix) continue;
    if (prefix === "别" && i > 0 && NOT_A_NEG_PREFIX_CHARS.includes(t[i - 1])) continue;
    let j = i + prefix.length;
    /* 「别的视频」= 其他视频，不是否定；但「别推荐视频」是否定 */
    if (prefix === "别" && t[j] === "的") continue;
    for (let guard = 0; guard < 8; guard++) {
      while (j < t.length && /\s/.test(t[j])) j++;
      const filler = NEG_VIDEO_FILLERS.find((w) => t.startsWith(w, j));
      if (!filler) break;
      j += filler.length;
    }
    while (j < t.length && /\s/.test(t[j])) j++;
    if (t.startsWith("视频", j)) return true;
  }
  return false;
}

export function parseResourceConstraint(text: string): ResourceConstraint {
  const t = text || "";
  const notVideo = hasNegatedVideo(t);
  const wantsVideo = !notVideo && /视频/.test(t);
  const noDoc = /不要(给我)?(文档|文章|PDF|资料)|只要视频/.test(t);
  const zh = /中文|普通话|汉语/.test(t);
  const mainland = /大陆|国内|中国(大陆)?能(够)?(直接)?访问|不用翻墙|无墙/.test(t);
  const excluded: string[] = [];
  if (noDoc) excluded.push("documentation", "article");
  return {
    /* notVideo 必须压过 noDoc：用户说「别推荐视频，不要文档」时 noDoc 命中，
     * 但把 resourceType 判成 video 同样是与意图相反（见上）。 */
    resourceType: notVideo ? "any" : wantsVideo || noDoc ? "video" : "any",
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
