/* ========= API 层：请求封装 + 会话 cookie 管理 + 同步接口 =========
 * 会话与 Web 端同源：服务端下发 mentora_session 签名 cookie。
 * 微信会自动管理同域名 cookie（真机可靠）；这里再做一层手动备份——
 * 开发者工具能读到 Set-Cookie 时手动带上，读不到就靠微信自动携带。 */
var config = require("../config.js");

var CK_KEY = "mentora-mp-session";

function ckKey() {
  return CK_KEY + "-" + config.currentId();
}

function savedCookie() {
  try {
    return wx.getStorageSync(ckKey()) || "";
  } catch (e) {
    return "";
  }
}

function saveCookie(v) {
  try {
    if (v) wx.setStorageSync(ckKey(), v);
    else wx.removeStorageSync(ckKey());
  } catch (e) { /* 忽略 */ }
}

/* 从响应头里提取 mentora_session（头名大小写不定、可能多值） */
function captureCookie(header) {
  if (!header) return;
  var raw = "";
  Object.keys(header).forEach(function (k) {
    if (k.toLowerCase() === "set-cookie") {
      var v = header[k];
      /* 尾部分隔符对两个分支都要有：数组分支裸 cookie（值后无 ; 属性）不带
       * 换行时，两个 set-cookie 键的值会直接拼在一起，下面的贪婪匹配把两段
       * 值合并捕获成一个损坏的 cookie 持久化下去。 */
      raw += (Array.isArray(v) ? v.join("\n") : String(v)) + "\n";
    }
  });
  /* 服务端 clearSessionCookie 用 jar.set(COOKIE, "", { maxAge: 0 }) 清会话，
   * 线上格式是裸的 `mentora_session=; Path=/; Max-Age=0`（值后无引号）。
   * 捕获量词必须允许空值（* 而非 +）：+ 会让这一分支永远匹配不到，本机
   * cookie 备份不会随服务端清除指令清掉（只有带引号的 `mentora_session=""`
   * 命中）。 */
  var m = /mentora_session=([^;\s]*)/.exec(raw);
  if (m) {
    if (m[1] === "" || m[1] === '""') saveCookie("");
    else saveCookie("mentora_session=" + m[1]);
  }
}

function authHeader() {
  var ck = savedCookie();
  return ck ? { Cookie: ck } : {};
}

/* 网络层失败 → 人话（JSON 请求通道与 chat.js 流式通道共用的唯一映射）。
 * 原始 errMsg 是英文技术串（"request:fail timeout" 等），调用方多数直接把
 * e.message 展示给用户（登录/注册的错误框就是）。此前 chat.js 流式层与本文件
 * 各写一份映射，已经漂移（"domain list" 分支只有 JSON 通道有）——同一类域名
 * 不可达错误在两条通道给用户不同文案。收口到一处后，微信新增 errMsg 形态
 * 只需要改这里。
 * 映射只覆盖网络层；服务端校验错误（中文文案）原样透传。
 * abortCopy：abort 的文案两条通道语义不同——JSON 通道是用户主动取消
 * （"请求已取消"），流式通道是生成被停止（"生成已停止"，有意为之），
 * 调用方用这个参数指定。 */
function netErrMsg(err, abortCopy) {
  var raw = (err && err.errMsg) || "";
  if (raw.indexOf("timeout") >= 0) return "请求超时，请检查网络后重试";
  if (raw.indexOf("abort") >= 0) return abortCopy || "请求已取消";
  if (raw.indexOf("domain list") >= 0) return "当前网络无法访问服务，请检查网络";
  return "网络请求失败，请检查网络后重试";
}

/* 基础请求：resolve {statusCode, data, header}；网络层失败才 reject */
function request(path, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    wx.request({
      url: config.current() + path,
      method: opts.method || "GET",
      data: opts.data,
      timeout: opts.timeout || 30000,
      header: Object.assign(
        { "Content-Type": "application/json" },
        authHeader(),
        opts.header || {}
      ),
      success: function (res) {
        captureCookie(res.header);
        resolve(res);
      },
      fail: function (err) {
        reject(new Error(netErrMsg(err)));
      }
    });
  });
}

/* JSON 请求：非 2xx 时 reject Error(服务端 error 文案) */
function requestJson(path, opts) {
  return request(path, opts).then(function (res) {
    var data = res.data;
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return data;
    }
    var msg =
      (data && data.error) || "请求失败（" + res.statusCode + "）";
    var err = new Error(msg);
    err.statusCode = res.statusCode;
    throw err;
  });
}

/* ---------------- 认证 ---------------- */

function login(email, password) {
  return requestJson("/api/auth/login", {
    method: "POST",
    data: { email: email, password: password }
  });
}

function register(payload) {
  return requestJson("/api/auth/register", {
    method: "POST",
    data: payload
  });
}

function me() {
  return requestJson("/api/auth/me");
}

function logout() {
  saveCookie("");
  return requestJson("/api/auth/logout", { method: "POST" }).catch(function () {
    /* 服务端登出失败也照常清本地 */
  });
}

function hasSession() {
  return Boolean(savedCookie());
}

function clearSession() {
  saveCookie("");
}

/* ---------------- 云端同步 ----------------
 * 快照形状 = Web 端 zustand persist 的数据（goals/knowledge/books/sessions/
 * customPersonas/settings）。GET 带 plain=1：小程序解不了 gzip，显式要明文
 * （后端已支持；>4.5MB 的极端快照仍会被服务端拒绝，那是硬上限）。 */

function pullCloud() {
  return requestJson("/api/sync?plain=1", { timeout: 60000 }).then(function (j) {
    if (!j || !j.data) return null;
    return { data: j.data, updatedAt: j.updatedAt || "" };
  });
}

function pushCloud(data) {
  return requestJson("/api/sync", {
    method: "POST",
    data: { data: data },
    timeout: 60000
  });
}

/* V26.2-H2：书籍真实性核查（POST /api/search，与 Web 的 /api/search 网关同源） */
function searchBooks(query) {
  return requestJson("/api/search", {
    method: "POST",
    data: { query: query }
  });
}

module.exports = {
  request: request,
  authHeaders: authHeader,
  requestBaseUrl: config.current,
  login: login,
  register: register,
  me: me,
  logout: logout,
  hasSession: hasSession,
  clearSession: clearSession,
  pullCloud: pullCloud,
  pushCloud: pushCloud,
  netErrMsg: netErrMsg,
  searchBooks: searchBooks
};
