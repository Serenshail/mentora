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

/* DNS 解析硬超时：黑洞域名的 lookup 会拖到系统级超时（十几秒） */
const DNS_TIMEOUT_MS = 3_000;

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // 畸形视为不安全
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // TEST-NET 等保留段
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试段（VPN/TUN fake-IP 常落此段）
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3 203.0.113.0/24
  if (a >= 224) return true; // 组播/保留
  return false;
}

/** 把任意合法 IPv6 写法（含 :: 缩写、IPv4 尾段）展开成 8 组 4 位十六进制；解析失败返回 null */
function expandV6(ip: string): string[] | null {
  let s = ip.toLowerCase();
  const v4tail = s.match(/^(.*):(\d+\.\d+\.\d+\.\d+)$/);
  if (v4tail) {
    const o = v4tail[2].split(".").map(Number);
    if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    s = `${v4tail[1]}:${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 && missing < 1) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const out: string[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(g.padStart(4, "0"));
  }
  return out;
}

function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase();
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]); // IPv4-mapped：按 v4 规则裁决
  /* 字符串相等判不了展开写法（"0:0:0:0:0:0:0:1" != "::1"，net.isIP 却都认）——
   * 一律展开成 8 组再按位裁决，堵住回环/ULA/链路本地/组播的变体写法旁路 */
  const groups = expandV6(s);
  if (!groups) return true; // 解析不了按不安全处理
  if (groups.slice(0, 6).every((g) => g === "0000")) {
    // ::（未指定）/ ::1（回环）/ ::x.y（已废弃的 IPv4-compatible）
    if (groups[6] === "0000" && groups[7] === "0000") return true;
    if (groups[6] === "0000" && groups[7] === "0001") return true;
    const a = parseInt(groups[6], 16);
    const b = parseInt(groups[7], 16);
    return isPrivateV4(`${(a >> 8) & 255}.${a & 255}.${(b >> 8) & 255}.${b & 255}`);
  }
  if (groups.slice(0, 5).every((g) => g === "0000") && groups[5] === "ffff") {
    const a = parseInt(groups[6], 16);
    const b = parseInt(groups[7], 16);
    return isPrivateV4(`${(a >> 8) & 255}.${a & 255}.${(b >> 8) & 255}.${b & 255}`);
  }
  /* 内嵌 IPv4 的 IPv6 形态：6to4/NAT64 把 v4 藏进中段或尾段，字符串层看不出私网，
   * 必须解出内嵌 v4 再按 v4 规则裁决（否则 [2002:7f00:1::] 这类直通形态层） */
  if (groups[0] === "2002") {
    // 6to4 2002::/16：v4 = 第 2、3 组
    const a = parseInt(groups[1], 16);
    const b = parseInt(groups[2], 16);
    return isPrivateV4(`${(a >> 8) & 255}.${a & 255}.${(b >> 8) & 255}.${b & 255}`);
  }
  if (groups[0] === "0064" && groups[1] === "ff9b") {
    if (groups[2] !== "0000") return true; // 64:ff9b:1::/48 本地专用 NAT64，无对应公网语义
    if (groups.slice(2, 6).every((g) => g === "0000")) {
      // 64:ff9b::/96 知名前缀：v4 = 末两组
      const a = parseInt(groups[6], 16);
      const b = parseInt(groups[7], 16);
      return isPrivateV4(`${(a >> 8) & 255}.${a & 255}.${(b >> 8) & 255}.${b & 255}`);
    }
    return true; // 前缀内非 /96 的非常规形态，按不安全处理
  }
  const g0 = parseInt(groups[0], 16);
  if (g0 === 0x2001 && groups[1] === "0000") return true; // Teredo 2001:0::/32（内嵌 v4 为取反编码，整体拒绝）
  if (g0 >= 0xfc00 && g0 <= 0xfdff) return true; // ULA fc00::/7
  if (g0 >= 0xfe80 && g0 <= 0xfebf) return true; // link-local fe80::/10
  if ((g0 & 0xff00) === 0xff00) return true; // 组播 ff00::/8
  if (g0 === 0x2001 && groups[1] === "0db8") return true; // 文档段 2001:db8::/32
  return false;
}

function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true; // 解析结果不是合法 IP（异常），按不安全处理
}

/* WHATWG URL 的 hostname 对 IPv6 带方括号返回（"[::1]"），net.isIP 认不出——
 * 剥掉括号再做字面量判定，否则形态层私网检查对全部 IPv6 写法失效 */
function urlHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
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
  const host = urlHost(u);
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
  const host = urlHost(u);
  if (net.isIP(host)) {
    return isPrivateAddress(host)
      ? { ok: false, reason: "目标地址不可达" }
      : { ok: true };
  }
  try {
    /* dns.lookup 无超时兜底：DNS 黑洞会拖十几秒，用户拿到的是网关 503 而非
     * 本守卫备好的「域名无法解析」——超时竞速 3s 后按解析失败处理 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    const addrs = await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("dns timeout")), DNS_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (addrs.length === 0) return { ok: false, reason: "域名无法解析" };
    if (addrs.some((a) => isPrivateAddress(a.address))) {
      return { ok: false, reason: "目标指向内部网络" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "域名无法解析" };
  }
}
