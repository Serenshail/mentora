import { NextRequest } from "next/server";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { getSessionUser } from "@/lib/server/auth";
import { dbEventSave, emailHash } from "@/lib/server/db";
import { logEvent } from "@/lib/server/config";

export const runtime = "nodejs";

/* 漏斗埋点接收端：logEvent 进结构化日志（Vercel 可查），D1 events 表留档可 SQL 聚合。
 * 匿名也记录（account=anon）——漏斗第一格是"访客开始引导"。 */

interface TrackBody {
  n?: string; // 事件名
  p?: Record<string, unknown>; // 属性（数值/枚举，不含内容原文）
  path?: string;
  t?: number;
}

export async function POST(req: NextRequest) {
  // 埋点是高频小请求：每 IP 突发 60、每秒回填 1（跨 isolate 持久桶）
  if (!(await rateLimitPersistent(`track:${clientIp(req)}`, { capacity: 60, refillPerSec: 1 }))) {
    return new Response(null, { status: 429 });
  }
  const raw = await req.text().catch(() => "");
  if (!raw || raw.length > 8_192) return new Response(null, { status: 400 });

  let body: TrackBody;
  try {
    body = JSON.parse(raw) as TrackBody;
  } catch {
    return new Response(null, { status: 400 });
  }
  const name = String(body.n ?? "");
  if (!/^[a-z0-9_.-]{1,64}$/i.test(name)) return new Response(null, { status: 400 });

  // 会话只做签名校验（不查库），派生匿名化账号 id
  const session = await getSessionUser();
  const account = session ? emailHash(session.email) : "anon";

  /* props 裁剪必须在对象层做：JSON.stringify 后 slice 会截出非法 JSON，
   * 下游 JSON.parse 只能 catch{continue} 静默丢弃，事后分析踩坑 */
  let props = "{}";
  try {
    const trimmed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body.p ?? {})) {
      trimmed[k.slice(0, 64)] = typeof v === "string" ? v.slice(0, 200) : v;
    }
    props = JSON.stringify(trimmed);
    while (props.length > 600) {
      const keys = Object.keys(trimmed);
      if (keys.length === 0) {
        props = "{}"; // 单个超大非字符串值兜底
        break;
      }
      delete trimmed[keys[keys.length - 1]]; // 超限丢尾部字段，直到落在预算内
      props = JSON.stringify(trimmed);
    }
  } catch {
    props = "{}";
  }
  const path = String(body.path ?? "").slice(0, 200);

  logEvent({ route: "track", name, account, path, props });
  await dbEventSave({ name, account, path, props }); // 内部 best-effort，绝不抛出

  return new Response(null, { status: 204 });
}
