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
      blocks: parsed.blocks,
      links: parsed.links,
      outLinks: outLinks,
      backLinks: backLinks,
      masteryLabel: mastery.LABELS[k.masteryStatus || "unknown"]
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
