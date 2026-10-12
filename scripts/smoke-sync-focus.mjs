/* 聚焦冒烟：注册→两次 sync→查版本。账号用完自删。 */
const BASE = "http://localhost:3000";
const EMAIL = `v17-sync-${Date.now().toString(36)}@163.com`;
const PW = "smoke-pw-123";
let cookie = "";
async function req(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { ...opts, headers });
  const sc = res.headers.get("set-cookie");
  if (sc) {
    const m = /mentora_session=([^;]+)/.exec(sc);
    if (m) cookie = `mentora_session=${m[1]}`;
  }
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}
const s = await req("/api/auth/send-code", { method: "POST", body: JSON.stringify({ email: EMAIL }) });
const r = await req("/api/auth/register", { method: "POST", body: JSON.stringify({ email: EMAIL, password: PW, code: s.body.devCode }) });
console.log("register", r.status, cookie ? "cookie-ok" : "NO-COOKIE");
let res = await req("/api/sync", { method: "POST", body: JSON.stringify({ data: { goals: [{ id: "a1" }], knowledge: [], books: [], sessions: [], customPersonas: [] } }) });
console.log("push1", res.status, JSON.stringify(res.body));
await new Promise((x) => setTimeout(x, 1200));
res = await req("/api/sync", { method: "POST", body: JSON.stringify({ data: { goals: [{ id: "a2" }], knowledge: [], books: [], sessions: [], customPersonas: [] } }) });
console.log("push2", res.status, JSON.stringify(res.body));
res = await req("/api/sync?versions=1");
console.log("versions", res.status, JSON.stringify(res.body));
await req("/api/auth/account", { method: "DELETE", body: JSON.stringify({ password: PW }) });
console.log("cleanup done");
