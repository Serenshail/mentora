var store = require("../../utils/store.js");
var chat = require("../../utils/chat.js");
var grade = require("../../utils/grade.js");
var util = require("../../utils/util.js");

Page({
  data: {
    phase: "idle", // idle | ask | answer | graded | done
    queueCount: 0,
    total: 0,
    correct: 0,
    noteTitle: "",
    noteDomain: "",
    noteExcerpt: "",
    question: "",
    questionBusy: false,
    answer: "",
    gradeBusy: false,
    verdict: null, // {verdict, evidence, feedback}
    minutes: 0,
    nextDate: ""
  },

  onLoad: function () {
    this.queue = store.dueReviews().map(function (k) {
      return k.id;
    });
    this.startedAt = 0;
    this.setData({
      queueCount: this.queue.length,
      total: this.queue.length
    });
  },

  start: function () {
    this.startedAt = Date.now();
    this.askNext(this.queue.slice());
  },

  askNext: function (queue) {
    var that = this;
    that.queue = queue;
    if (!queue.length) {
      var minutes = that.startedAt
        ? Math.max(1, Math.round((Date.now() - that.startedAt) / 60000))
        : 1;
      var dates = store.state.knowledge
        .filter(function (k) {
          return k.nextReviewAt;
        })
        .map(function (k) {
          return k.nextReviewAt;
        })
        .sort();
      that.setData({
        phase: "done",
        queueCount: 0,
        minutes: minutes,
        nextDate: dates[0] || ""
      });
      return;
    }
    var item = store.knowledgeById(queue[0]);
    if (!item) {
      that.askNext(queue.slice(1));
      return;
    }
    that.setData({
      phase: "ask",
      question: "",
      answer: "",
      verdict: null,
      noteTitle: item.title,
      noteDomain: item.domain || "",
      noteExcerpt: "",
      questionBusy: true
    });
    var items = store.state.knowledge
      .filter(function (k) {
        return queue.indexOf(k.id) >= 0;
      })
      .map(function (k) {
        return { title: k.title, summary: (k.body || "").slice(0, 120), domain: k.domain };
      });
    chat
      .streamChat({
        task: "review-ask",
        args: { items: JSON.stringify(items) },
        messages: [{ role: "user", content: "出题。" }],
        onDelta: function (d) {
          that.setData({ question: that.data.question + d });
        }
      })
      .then(function () {
        that.setData({ phase: "answer", questionBusy: false });
      })
      .catch(function () {
        util.toast("复习出题失败，稍后再试");
        that.setData({ phase: "idle", questionBusy: false });
      });
  },

  onAnswer: function (e) {
    this.setData({ answer: e.detail.value });
  },

  submit: function () {
    var that = this;
    var id = that.queue[0];
    var item = store.knowledgeById(id);
    var answer = that.data.answer.trim();
    if (!item || !answer) {
      util.toast("写点什么再提交");
      return;
    }
    if (that.data.gradeBusy) return;
    that.setData({ gradeBusy: true, verdict: null });
    chat
      .streamChat({
        task: "review-grade",
        args: {
          ctx: JSON.stringify({
            note: item.title,
            excerpt: (item.body || "").slice(0, 800),
            question: that.data.question,
            answer: answer
          })
        },
        messages: [{ role: "user", content: answer }],
        temperature: 0.2,
        onDelta: function () {}
      })
      .then(function (full) {
        var g = grade.normalizeReviewGrade(chat.extractJson(full));
        that.setData({ verdict: g, phase: "graded" });
        if (g.verdict === "pass") {
          that.setData({ correct: that.data.correct + 1 });
        }
        store.recordReview(id, g.verdict === "pass");
      })
      .catch(function () {
        util.toast("评分服务暂不可用，你的回答没有丢——稍等再点一次提交");
      })
      .then(function () {
        that.setData({ gradeBusy: false });
      });
  },

  next: function () {
    this.askNext(this.queue.slice(1));
  },

  again: function () {
    wx.redirectTo({ url: "/pages/review/review" });
  },

  back: function () {
    wx.navigateBack();
  }
});
