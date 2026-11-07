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
      raw += Array.isArray(v) ? v.join("\n") : String(v) + "\n";
    }
  });
  var m = /mentora_session=([^;\s]+)/.exec(raw);
  if (m) {
    if (m[1] === "" || m[1] === '""') saveCookie("");
    else saveCookie("mentora_session=" + m[1]);
  }
}

function authHeader() {
  var ck = savedCookie();
  return ck ? { Cookie: ck } : {};
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
        reject(new Error((err && err.errMsg) || "网络请求失败"));
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

function health() {
  return requestJson("/api/health", { timeout: 15000 });
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
  health: health,
  searchBooks: searchBooks
};
