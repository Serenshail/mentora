/* ========= 后端地址配置 =========
 * Mentora 小程序与 Web 端共用同一后端（同一账号、同一份云端数据）。
 * 三个可选后端，在「我的 → 后端」里切换：
 *  - prod   官方部署（Vercel）。开发者工具里走本机代理可达；大陆真机直连不通。
 *  - tunnel UUMit 隧道 → 本机 3000（需要电脑上 next start 在跑，KeepAlive 计划任务会拉起）。
 *  - local  电脑本机 3000，仅开发者工具里用（需勾选「不校验合法域名」）。
 * 正式发布前需要：HTTPS + ICP 备案的可达域名，配进小程序后台 request 合法域名。 */
var BASES = {
  prod: "https://mentora-orpin.vercel.app",
  tunnel: "https://app-3000--laptop-f23gvvb6.uua2a.com",
  local: "http://localhost:3000"
};

var KEY = "mentora-mp-base";

function current() {
  try {
    var saved = wx.getStorageSync(KEY);
    if (saved && BASES[saved]) return BASES[saved];
  } catch (e) { /* 存储不可用时用默认 */ }
  return BASES.prod;
}

function currentId() {
  try {
    var saved = wx.getStorageSync(KEY);
    if (saved && BASES[saved]) return saved;
  } catch (e) { /* 同上 */ }
  return "prod";
}

function set(id) {
  if (!BASES[id]) return;
  try {
    wx.setStorageSync(KEY, id);
  } catch (e) { /* 忽略 */ }
}

module.exports = {
  BASES: BASES,
  current: current,
  currentId: currentId,
  set: set
};
