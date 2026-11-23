var api = require("../../utils/api.js");
var store = require("../../utils/store.js");
var util = require("../../utils/util.js");

Page({
  data: {
    mode: "login", // login | register
    email: "",
    password: "",
    name: "",
    inviteCode: "",
    busy: false,
    error: ""
  },

  onEmail: function (e) { this.setData({ email: e.detail.value }); },
  onPassword: function (e) { this.setData({ password: e.detail.value }); },
  onName: function (e) { this.setData({ name: e.detail.value }); },
  onInvite: function (e) { this.setData({ inviteCode: e.detail.value }); },

  switchMode: function () {
    this.setData({
      mode: this.data.mode === "login" ? "register" : "login",
      error: ""
    });
  },

  submit: function () {
    var that = this;
    if (that.data.busy) return;
    var email = that.data.email.trim().toLowerCase();
    var password = that.data.password;
    if (!email || !password) {
      that.setData({ error: "邮箱和密码都要填" });
      return;
    }
    that.setData({ busy: true, error: "" });
    var req;
    if (that.data.mode === "login") {
      req = api.login(email, password);
    } else {
      req = api.register({
        email: email,
        password: password,
        name: that.data.name.trim(),
        inviteCode: that.data.inviteCode.trim()
      });
    }
    req
      .then(function (j) {
        var user = j.user;
        getApp().globalData.user = user;
        return store.onLogin(user.userId).then(function (r) {
          /* 首次云端拉取失败要显式提示：旧实现照样报「登录成功」跳转，
           * 新手机上落地只见空态，与账号为空不可区分。
           * conflict（本机遗留改动 vs 他端已更新的云端）同样不能报「登录成功」了事：
           * 两端都没被改动，用户必须知道去哪里手动选。 */
          if (r === "error") {
            util.toast("登录成功，但云端拉取失败，稍后可在「我的」里手动同步");
          } else if (r === "conflict") {
            util.toast("登录成功：云端已有他端更新，本机也有未推送改动，请在「我的 → 数据」里选择");
          } else {
            util.toast("登录成功", "success");
          }
          wx.switchTab({ url: "/pages/overview/overview" });
        });
      })
      .catch(function (e) {
        that.setData({ error: e.message || "登录失败" });
      })
      .then(function () {
        that.setData({ busy: false });
      });
  }
});
