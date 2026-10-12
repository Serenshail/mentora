import "server-only";
import dns from "node:dns/promises";
import net from "node:net";

/* ============================================================
 * 统一出网 URL 守卫（linkcheck 资源体检 / BYOK 自定义端点共用）
 *
 * 三层防护：
 *  1) 形态：协议白名单、禁 userinfo、禁非常规端口；
 *  2) 字面 IP：十进制/十六进制 IP（2130706433 这类 inet_aton 旁路）
 *     在形态层无法穷举，靠第 3 层解析后统一裁决；
 *  3) DNS 解析取证：主机名解析出的每个地址都必须是公网地址
 *     （挡内网域名、回环、链路本地、云元数据、IPv4-mapped IPv6）。
 *
 * 注意：这是"请求前校验"，存在极窄的 DNS rebinding TOCTOU 窗口；
 * 对本产品（无特权网络、纯 KV 后端）该强度足够，不为此引入自定义 socket agent。
 * ============================================================ */

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // 畸形视为不安全
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // TEST-NET 等保留段
  if (a >= 224) return true; // 组播/保留
  return false;
}

function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase();
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]); // IPv4-mapped：按 v4 规则裁决
  if (s === "::1" || s === "::") return true;
  if (s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd")) return true; // link-local/ULA
  if (s.startsWith("ff")) return true; // 组播
  if (s.startsWith("2001:db8")) return true; // 文档段
  return false;
}

function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true; // 解析结果不是合法 IP（异常），按不安全处理
}

/** 形态检查；返回解析后的 URL 或 null。allowHttp=false 时仅放行 https（服务端出网端点用） */
export function checkUrlShape(raw: string, opts: { allowHttp: boolean }): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  const host = u.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return null;
  // 字面 IPv4/IPv6：形态层直接按私网规则否决（十进制/十六进制 inet_aton 写法交给解析层）
  if (net.isIP(host) && isPrivateAddress(host)) return null;
  return u;
}

/** 完整校验：形态 + DNS 解析取证。所有解析地址必须全部公网才放行 */
export async function assertSafePublicUrl(
  raw: string,
  opts: { allowHttp: boolean }
): Promise<{ ok: boolean; reason?: string }> {
  const u = checkUrlShape(raw, opts);
  if (!u) return { ok: false, reason: "地址格式不受支持" };
  const host = u.hostname;
  if (net.isIP(host)) {
    return isPrivateAddress(host)
      ? { ok: false, reason: "目标地址不可达" }
      : { ok: true };
  }
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.length === 0) return { ok: false, reason: "域名无法解析" };
    if (addrs.some((a) => isPrivateAddress(a.address))) {
      return { ok: false, reason: "目标指向内部网络" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "域名无法解析" };
  }
}
