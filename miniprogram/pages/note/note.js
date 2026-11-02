var store = require("../../utils/store.js");
var md = require("../../utils/md.js");
var mastery = require("../../utils/mastery.js");

Page({
  data: {
    note: null,
    blocks: [],
    links: [],
    outLinks: [],
    backLinks: [],
    chips: [],
    masteryLabel: ""
  },

  onLoad: function (query) {
    this.noteId = query.noteId;
  },

  onShow: function () {
    this.render();
  },

  render: function () {
    var k = store.knowledgeById(this.noteId);
    if (!k) {
      this.setData({ note: null });
      return;
    }
    var parsed = md.parse(k.body || "");
    var st = store.state;
    var byId = {};
    st.knowledge.forEach(function (x) {
      byId[x.id] = x;
    });
    var outLinks = (k.links || [])
      .map(function (id) {
        return byId[id] ? { id: id, title: byId[id].title } : null;
      })
      .filter(Boolean);
    var backLinks = st.knowledge
      .filter(function (x) {
        return (x.links || []).indexOf(k.id) >= 0;
      })
      .map(function (x) {
        return { id: x.id, title: x.title };
      });
    wx.setNavigationBarTitle({ title: k.title.slice(0, 12) });
    // 元信息收成 chips：掌握度有值才显示，避免"未测"占位噪音
    var masteryLabel = mastery.LABELS[k.masteryStatus || "unknown"];
    var chips = [];
    if (masteryLabel && masteryLabel !== "未测") chips.push({ text: masteryLabel, tone: "accent" });
    if (k.nextReviewAt) chips.push({ text: "复习 " + k.nextReviewAt, tone: "dim" });
    if (k.unresolved) chips.push({ text: "未解析链接", tone: "dim" });
    (k.tags || []).forEach(function (t) {
      chips.push({ text: "#" + t, tone: "dim" });
    });

    this.setData({
      note: {
        id: k.id,
        title: k.title,
        domain: k.domain || "",
        sourceTitle: k.sourceTitle || "",
        tags: k.tags || [],
        nextReviewAt: k.nextReviewAt || "",
        body: k.body || ""
      },
      chips: chips,
      blocks: parsed.blocks,
      links: parsed.links,
      outLinks: outLinks,
      backLinks: backLinks,
      masteryLabel: masteryLabel
    });
  },

  copyCode: function (e) {
    wx.setClipboardData({ data: e.currentTarget.dataset.code || "" });
  },

  copyLink: function (e) {
    wx.setClipboardData({ data: e.currentTarget.dataset.url || "" });
  },

  noop: function () {},

  openLinked: function (e) {
    var id = e.currentTarget.dataset.id;
    wx.redirectTo({ url: "/pages/note/note?noteId=" + id });
  }
});
