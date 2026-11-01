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
        return store.onLogin(user.userId).then(function () {
          util.toast("登录成功", "success");
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
