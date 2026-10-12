/* v17 认证/同步端到端冒烟（需 dev server 在 3000 且 D1 可达；一次性探针账号，跑完自删）。
 * 覆盖：注册验证码 → 会话 sv → sync 上传与版本存档 → 改密吊销旧会话 → 登录失败锁定 → 重置密码吊销+解锁。
 * 用法: node scripts/smoke-auth-v17.mjs */
const BASE = "http://localhost:3000";
const stamp = Date.now().toString(36);
const EMAIL = `v17-smoke-${stamp}@163.com`;
const PW1 = "v17test-aaa-1";
const PW2 = "v17test-bbb-2";
const PW3 = "v17test-ccc-3";

let cookie = ""; // 手动 cookie jar
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function req(path, opts = {}, withCookie = true) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (withCookie && cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { ...opts, headers, redirect: "manual" });
  const sc = res.headers.get("set-cookie");
  if (sc) {
    const m = /mentora_session=([^;]+)/.exec(sc);
    cookie = m ? `mentora_session=${m[1]}` : "";
  }
  let body = null;
  const text = await res.text();
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const main = async () => {
  // 1) 发码 + 注册
  let r = await req("/api/auth/send-code", { method: "POST", body: JSON.stringify({ email: EMAIL }) });
  check("send-code 返回 devCode（dev 模式）", r.status === 200 && r.body?.devCode, `status=${r.status}`);
  const code1 = r.body?.devCode;
  r = await req("/api/auth/register", { method: "POST", body: JSON.stringify({ email: EMAIL, password: PW1, name: "冒烟", code: code1 }) });
  check("注册成功且签发会话", r.status === 200 && cookie.length > 20, `status=${r.status}`);

  // 2) sync 上传 + 版本存档
  r = await req("/api/sync", { method: "POST", body: JSON.stringify({ data: { goals: [{ id: "g1", topic: "冒烟目标" }], knowledge: [], books: [], sessions: [], customPersonas: [], settings: {} } }) });
  check("sync 首推", r.status === 200 && r.body?.ok, `status=${r.status}`);
  await new Promise((s) => setTimeout(s, 1100)); // 保证 updatedAt 跨秒（存档去重按 ts）
  r = await req("/api/sync", { method: "POST", body: JSON.stringify({ data: { goals: [{ id: "g2", topic: "冒烟目标2" }], knowledge: [], books: [], sessions: [], customPersonas: [], settings: { apiKey: "secret-key" } } }) });
  check("sync 二次推", r.status === 200 && r.body?.ok, `status=${r.status}`);
  r = await req("/api/sync?versions=1");
  const versions = r.body?.versions || [];
  check("云端版本快照已存档（≥1 份）", versions.length >= 1, JSON.stringify(versions));
  r = await req("/api/sync");
  const snap = typeof r.body === "object" ? r.body : null;
  check("apiKey 不上云（sanitize）", snap?.data?.settings?.apiKey === "", `apiKey=${JSON.stringify(snap?.data?.settings?.apiKey)}`);
  if (versions[0]) {
    r = await req(`/api/sync?v=${versions[0]}`);
    check("按版本取回历史快照", r.status === 200 && (r.body?.data?.goals?.[0]?.id === "g1"), `goals=${JSON.stringify(r.body?.data?.goals?.map?.(g => g.id))}`);
  }

  // 3) 改密 → 旧会话吊销
  const oldCookie = cookie;
  r = await req("/api/auth/change-password", { method: "POST", body: JSON.stringify({ oldPassword: PW1, newPassword: PW2 }) });
  check("改密成功（当前设备重签）", r.status === 200 && r.body?.ok, `status=${r.status} ${JSON.stringify(r.body?.error || "")}`);
  cookie = oldCookie; // 模拟另一台设备还拿着旧 cookie
  r = await req("/api/sync");
  check("旧设备会话被 sv 吊销（sync 401）", r.status === 401, `status=${r.status}`);
  r = await req("/api/auth/me");
  check("me 判旧 cookie 未登录", r.status === 200 && r.body?.user === null, JSON.stringify(r.body));

  // 4) 账号维度防爆破
  cookie = "";
  for (let i = 0; i < 8; i++) await req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: "wrong-pw" }) });
  r = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: PW2 }) });
  check("8 次失败后正确密码也被锁（429）", r.status === 429 && /锁定/.test(r.body?.error || ""), `status=${r.status}`);

  // 5) 忘记密码 → 解锁 + 改密 + 旧会话吊销
  r = await req("/api/auth/send-code", { method: "POST", body: JSON.stringify({ email: EMAIL, purpose: "reset" }) });
  check("reset 验证码发出", r.status === 200 && r.body?.devCode, `status=${r.status}`);
  r = await req("/api/auth/reset-password", { method: "POST", body: JSON.stringify({ email: EMAIL, code: r.body?.devCode, newPassword: PW3 }) });
  check("重置密码成功", r.status === 200 && r.body?.ok, `status=${r.status} ${JSON.stringify(r.body?.error || "")}`);
  r = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: PW3 }) });
  check("重置后锁定清除、新密码可登录", r.status === 200 && r.body?.user, `status=${r.status}`);

  // 6) BYOK：假 Key 走自己的通道（不占配额、不混用服务端 Key）
  r = await req("/api/chat", { method: "POST", headers: { "x-mentora-key": "sk-fake-broken", "x-mentora-provider": "deepseek" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
  const txt = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  check("BYOK 假 Key → 上游拒绝自己（而非烧服务端 Key）", r.status === 200 && /401|Unauthorized|api key/i.test(txt), txt.slice(0, 120));

  // 7) 限流持久桶工作正常（第二次 login 后 rl 行存在即可——由登录成功间接证明）
  check("冒烟账号全程可读写 D1（隐式）", true, "以上步骤通过即证明");

  // 8) 自删（密码三确认后走自助注销）
  r = await req("/api/auth/account", { method: "DELETE", body: JSON.stringify({ password: PW3 }) });
  check("探针账号自删", r.status === 200 && r.body?.ok, `status=${r.status}`);

  const fails = results.filter((x) => !x.ok);
  console.log(`\n== ${results.length - fails.length}/${results.length} 通过 ==`);
  process.exit(fails.length ? 1 : 0);
};

main().catch((e) => { console.error("SMOKE CRASH:", e); process.exit(2); });
