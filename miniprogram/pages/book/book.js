var store = require("../../utils/store.js");
var chat = require("../../utils/chat.js");
var modes = require("../../utils/modes.js");
var md = require("../../utils/md.js");
var util = require("../../utils/util.js");
var streamView = require("../../utils/stream-view.js");

function toChatView(messages) {
  return messages.map(function (m) {
    if (m.role === "assistant") {
      return { role: "assistant", blocks: md.parse(m.content).blocks };
    }
    return { role: "user", content: m.content };
  });
}

Page({
  data: {
    book: null,
    chapter: null,
    mode: null, // 当前模式元数据
    modes: modes.MODES,
    chatView: [],   // {role, content | blocks}
    input: "",
    busy: false,
    streamBlocks: [],
    showModes: false,
    showChapters: false,
    chapters: [],
    doneCount: 0,
    toBottom: "",
    navH: "" // 由 nav-bar 组件量出后回写
  },

  onLoad: function (query) {
    this.bookId = query.bookId;
  },

  onShow: function () {
    this.render();
  },

  render: function () {
    var b = store.bookById(this.bookId);
    if (!b) {
      this.setData({ book: null });
      return;
    }
    var chapter =
      b.chapters.filter(function (c) { return c.status === "todo"; })[0] || b.chapters[0] || null;
    var modeId = b.chatMode || modes.defaultMode(chapter && chapter.knowledgeType);
    var chatView = toChatView(b.chat || []);
    var doneCount = b.chapters.filter(function (c) { return c.status === "done"; }).length;
    wx.setNavigationBarTitle({ title: b.title.slice(0, 12) });
    this.setData({
      book: {
        id: b.id,
        title: b.title,
        author: b.author || "",
        planSummary: b.planSummary || "",
        modeJustSwitched: Boolean(b.modeJustSwitched)
      },
      chapter: chapter
        ? {
            id: chapter.id,
            index: b.chapters.indexOf(chapter) + 1,
            title: chapter.title,
            focusQuestion: chapter.focusQuestion || "",
            coreIdea: chapter.coreIdea || "",
            knowledgeType: chapter.knowledgeType || "concept",
            status: chapter.status
          }
        : null,
      mode: modes.byId(modeId),
      chatView: chatView,
      doneCount: doneCount,
      chapters: b.chapters.map(function (c, i) {
        return { id: c.id, title: c.title, status: c.status, index: i + 1 };
      })
    });
    this.scrollBottom();
  },

  /* 这页用的是内部 scroll-view（不是页面滚动），
   * 所以必须用 scroll-into-view 定位到底部锚点；
   * 之前调 wx.pageScrollTo 在这页永远不会生效。 */
  scrollBottom: function () {
    var that = this;
    wx.nextTick(function () {
      that.setData({ toBottom: "chat-bottom" });
    });
  },

  toggleModes: function () {
    this.setData({ showModes: !this.data.showModes, showChapters: false });
  },

  toggleChapters: function () {
    this.setData({ showChapters: !this.data.showChapters, showModes: false });
  },

  pickMode: function (e) {
    var id = e.currentTarget.dataset.id;
    var switching = this.data.mode.id !== id;
    store.updateBook(this.bookId, {
      chatMode: id,
      modeJustSwitched: switching ? true : false
    });
    this.setData({ showModes: false });
    this.render();
  },

  pickChapter: function (e) {
    var id = e.currentTarget.dataset.id;
    var b = store.bookById(this.bookId);
    var c = null;
    b.chapters.forEach(function (x) {
      if (x.id === id) c = x;
    });
    this.setData({ showChapters: false, chapter: c });
  },

  onInput: function (e) {
    this.setData({ input: e.detail.value });
  },

  bookCtx: function () {
    var b = store.bookById(this.bookId);
    var chapter = this.data.chapter;
    return JSON.stringify(
      {
        title: b.title,
        author: b.author,
        planSummary: b.planSummary,
        currentChapter: chapter
          ? {
              title: chapter.title,
              focusQuestion: chapter.focusQuestion,
              knowledgeType: chapter.knowledgeType || "concept",
              coreIdea: chapter.coreIdea
            }
          : null,
        pastedExcerpt: (b.pastedText || "").slice(0, 2000),
        insights: (b.insights || []).map(function (i) { return i.text; })
      },
      null,
      1
    );
  },

  send: function () {
    var that = this;
    var text = that.data.input.trim();
    if (!text || that.data.busy) return;
    that.setData({ input: "", busy: true, stream: "" });
    var modeSwitch = that.data.book.modeJustSwitched === true;
    var sendOpts = {
      args: { bookCtx: that.bookCtx(), ragCtx: "", mode: that.data.mode.id, modeSwitch: modeSwitch },
      userText: text,
      task: "reading-chat"
    };
    store.addBookMsg(that.bookId, {
      id: util.uid("m"),
      role: "user",
      content: text,
      at: new Date().toISOString()
    });
    if (modeSwitch) store.updateBook(that.bookId, { modeJustSwitched: false });
    var chatView = that.data.chatView.concat([{ role: "user", content: text }]);
    that.setData({ chatView: chatView });
    that.scrollBottom();
    var stream = "";
    var renderer = streamView.createStreamRenderer(function () {
      that.setData({ streamBlocks: md.parse(stream).blocks });
    }, 180);
    chat
      .streamChat({
        task: sendOpts.task,
        args: sendOpts.args,
        messages: [{ role: "user", content: text }],
        onDelta: function (d) {
          stream += d;
          renderer.push();
        }
      })
      .then(function (full) {
        renderer.flush();
        var content = full || stream;
        store.addBookMsg(that.bookId, {
          id: util.uid("m"),
          role: "assistant",
          content: content,
          at: new Date().toISOString()
        });
        that.setData({
          chatView: that.data.chatView.concat([
            { role: "assistant", blocks: md.parse(content).blocks }
          ]),
          streamBlocks: []
        });
        that.scrollBottom();
      })
      .catch(function (e) {
        renderer.cancel();
        util.toast(e.message || "发送失败");
        that.setData({ stream: "" });
      })
      .then(function () {
        that.setData({ busy: false });
      });
  },

  copyCode: function (e) {
    wx.setClipboardData({ data: e.currentTarget.dataset.code || "" });
  }
});
