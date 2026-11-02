var store = require("../../utils/store.js");
var chat = require("../../utils/chat.js");
var grade = require("../../utils/grade.js");
var mastery = require("../../utils/mastery.js");
var md = require("../../utils/md.js");
var util = require("../../utils/util.js");
var streamView = require("../../utils/stream-view.js");

var VERDICT_LABEL = {
  correct: { label: "过", tone: "ok" },
  partially_correct: { label: "部分", tone: "warn" },
  incorrect: { label: "不对", tone: "bad" },
  ungradable: { label: "不计", tone: "dim" }
};

Page({
  data: {
    goalId: "",
    dayId: "",
    day: null,
    goalTopic: "",
    readOnly: false,
    tab: "lesson",
    // 讲义
    lessonBlocks: [],
    lessonBusy: false,
    // 资料
    resources: [],
    // 答疑
    qaView: [],
    qaInput: "",
    qaBusy: false,
    qaStreamBlocks: [],
    // 验收
    quizMode: "learn", // learn | quiz | result
    acceptance: [],
    answers: {},
    canSubmitQuiz: false,
    grading: false,
    grade: null,
    // 迁移门
    gateQuestion: "",
    gateAnswer: "",
    gateBusy: false,
    // 跳过
    skipText: "",
    // 链接清单
    links: []
  },

  setTab: function (e) {
    var tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.setData({ tab: tab });
  },

  retryQuiz: function () {
    this.setData({ grade: null, quizMode: "quiz", answers: {}, canSubmitQuiz: false });
  },

  onLoad: function (query) {
    this.setData({ goalId: query.goalId, dayId: query.dayId });
  },

  onShow: function () {
    this.render();
  },

  currentDay: function () {
    var goal = store.goalById(this.data.goalId);
    if (!goal || !goal.plan) return null;
    return goal.plan.days[this.data.dayId] || null;
  },

  render: function () {
    var goal = store.goalById(this.data.goalId);
    var day = this.currentDay();
    if (!goal || !day) {
      util.toast("目标或学习日不存在");
      return;
    }
    var readOnly = goal.status !== "active" || day.status === "passed" || day.status === "skipped";
    var lessonMd = day.lesson || "";

    /* 解析缓存（页面实例级，跟着页面走）：
     * onShow 每次都会 render，QA 历史/讲义的内容没变就不该重解析。
     * 键 = 内容签名（长度 + 首尾采样），内容变了自动失效。 */
    if (!this._parseCache) this._parseCache = {};
    var cache = this._parseCache;
    var sig = function (s) {
      return s ? s.length + ":" + (s.slice(0, 40) + "|" + s.slice(-40)) : "";
    };

    var lessonSig = sig(lessonMd);
    if (cache._lessonSig !== lessonSig) {
      cache._lessonSig = lessonSig;
      cache._lesson = lessonMd ? md.parse(lessonMd) : { blocks: [], links: [] };
    }
    var parsed = cache._lesson;

    var qaSig = [];
    (day.qa || []).forEach(function (m) {
      qaSig.push(m.role[0] + sig(m.content));
    });
    qaSig = qaSig.join("\n");
    if (cache._qaSig !== qaSig) {
      cache._qaSig = qaSig;
      cache._qaView = (day.qa || []).map(function (m) {
        if (m.role === "assistant") return { role: "assistant", blocks: md.parse(m.content).blocks };
        return { role: "user", content: m.content };
      });
    }

    var resources = (day.resources || []).map(function (r, i) {
      return {
        _i: i,
        title: r.title,
        url: r.url || "",
        why: r.why || "",
        kind: r.kind || "",
        kindLabel: r.kind === "course" ? "视频课" : r.kind === "doc" ? "文档" : r.kind === "official" ? "官方" : r.kind === "repo" ? "仓库" : r.kind === "paper" ? "论文" : r.kind === "book" ? "书" : "资料"
      };
    });
    this.setData({
      goalTopic: goal.topic,
      readOnly: readOnly,
      day: {
        title: day.title,
        method: day.method || "",
        status: day.status,
        attempts: day.attempts || 0,
        stub: Boolean(day.stub),
        pendingUnlock: Boolean(day.pendingUnlock),
        kps: (day.knowledgePoints || []).map(function (k) { return k.text; })
      },
      lessonBlocks: parsed.blocks,
      links: parsed.links,
      resources: resources,
      qaView: cache._qaView,
      acceptance: (day.acceptance || []).map(function (a) {
        return { id: a.id, kind: a.kind, question: a.question, hint: a.hint || "" };
      }),
      gateQuestion: day.transferQuestion || "",
      gateAnswer: day.transferAnswer || ""
    });
  },

  copyCode: function (e) {
    var code = e.currentTarget.dataset.code || "";
    wx.setClipboardData({ data: code });
  },

  copyLink: function (e) {
    var url = e.currentTarget.dataset.url || "";
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: function () {
        util.toast("链接已复制，去浏览器打开");
      }
    });
  },

  copyAllLinks: function () {
    var urls = this.data.links
      .map(function (l) { return l.url; })
      .filter(function (u) { return u; });
    if (!urls.length) return;
    wx.setClipboardData({ data: urls.join("\n") });
    util.toast(urls.length + " 条链接已复制");
  },

  /* ---------------- 讲义生成（task=lesson，流式） ---------------- */

  genLesson: function () {
    var that = this;
    var goal = store.goalById(this.data.goalId);
    var day = this.currentDay();
    if (!goal || !day || that.data.lessonBusy) return;
    if (day.lesson) {
      // 已有讲义：确认后重新生成
      wx.showModal({
        title: "重新生成讲义？",
        content: "现有讲义会被覆盖。",
        success: function (res) {
          if (res.confirm) that.doGenLesson();
        }
      });
      return;
    }
    that.doGenLesson();
  },

  doGenLesson: function () {
    var that = this;
    var goal = store.goalById(this.data.goalId);
    var day = this.currentDay();
    if (!goal || !day) return;
    that.setData({ lessonBusy: true, lessonBlocks: [] });
    var mastered = [];
    Object.keys(goal.plan.days).forEach(function (k) {
      var d = goal.plan.days[k];
      if ((d.status === "passed" || d.status === "skipped") && d.id !== day.id) {
        d.knowledgePoints.forEach(function (kp) {
          mastered.push(kp.text);
        });
      }
    });
    var phase = null;
    goal.plan.phases.forEach(function (ph) {
      if (ph.id === day.phaseId) phase = ph;
    });
    var ctx = JSON.stringify({
      goal: {
        topic: goal.topic,
        direction: goal.direction,
        background: goal.background,
        domainKind: goal.domainKind,
        learnerProfile: goal.learnerProfile || []
      },
      mastered: mastered,
      phaseBoundary: (phase && phase.boundary) || "",
      today: {
        title: day.title,
        knowledgePoints: (day.knowledgePoints || []).map(function (k) { return k.text; }),
        method: day.method,
        example: day.example
      }
    });
    var buf = "";
    /* 性能（官方 setData 纪律）：流式期间 delta 只进本地缓冲，
     * 节流到 ~180ms 才做一次 md.parse + setData。此前每个 delta 都
     * 全文重解析 + 整包传输，长讲义是 O(n²)——这是"点起来特别卡"的最大来源。 */
    var renderer = streamView.createStreamRenderer(function () {
      that.setData({ lessonBlocks: md.parse(buf).blocks });
    }, 180);
    chat
      .streamChat({
        task: "lesson",
        args: { ctx: ctx },
        messages: [{ role: "user", content: "生成今天的学习文档。" }],
        temperature: 0.6,
        onDelta: function (d) {
          buf += d;
          renderer.push();
        },
        onThink: function () {}
      })
      .then(function (full) {
        renderer.flush();
        var text = full || buf;
        if (text.trim().length > 0) {
          that.saveLesson(goal, day, text);
        } else {
          util.toast("生成内容为空，稍后再试");
        }
      })
      .catch(function (e) {
        renderer.cancel();
        if (buf.trim().length > 200) {
          that.saveLesson(goal, day, buf);
          util.toast("生成中断，已保留已生成的内容");
        } else {
          util.toast(e.message || "生成失败");
        }
      })
      .then(function () {
        that.setData({ lessonBusy: false });
      });
  },

  saveLesson: function (goal, day, text) {
    // 直接写回 plan.days[dayId].lesson（与 Web saveLesson 同语义）
    var plan = util.clone(goal.plan);
    if (plan.days[day.id]) {
      plan.days[day.id].lesson = text;
      goal.plan = plan;
      store.markDirtyPublic();
    }
    this.render();
  },

  /* ---------------- 答疑（task=coach-qa，流式） ---------------- */

  onQaInput: function (e) {
    this.setData({ qaInput: e.detail.value });
  },

  sendQa: function () {
    var that = this;
    var text = that.data.qaInput.trim();
    var goal = store.goalById(this.data.goalId);
    var day = this.currentDay();
    if (!text || that.data.qaBusy || !goal || !day) return;
    that.setData({ qaInput: "", qaBusy: true, qaStreamBlocks: [] });
    var qa = (day.qa || []).concat([
      { id: util.uid("m"), role: "user", content: text, at: new Date().toISOString() }
    ]);
    var plan = util.clone(goal.plan);
    plan.days[day.id].qa = qa;
    goal.plan = plan;
    store.markDirtyPublic();
    that.setData({
      qaView: qa.map(function (m) { return { role: m.role, content: m.content }; })
    });
    var ctx = JSON.stringify({
      topic: goal.topic,
      today: day.title,
      knowledgePoints: (day.knowledgePoints || []).map(function (k) { return k.text; }),
      learnerProfile: goal.learnerProfile || []
    });
    var stream = "";
    /* 同讲义：delta 只进缓冲，节流刷新（避免每 delta 全文重解析 + 全量传输） */
    var renderer = streamView.createStreamRenderer(function () {
      that.setData({ qaStreamBlocks: md.parse(stream).blocks });
    }, 180);
    chat
      .streamChat({
        task: "coach-qa",
        args: { ctx: ctx, ragCtx: "" },
        messages: qa.slice(-6).map(function (m) { return { role: m.role, content: m.content }; }),
        onDelta: function (d) {
          stream += d;
          renderer.push();
        }
      })
      .then(function (full) {
        renderer.flush();
        var content = full || stream;
        var finalQa = qa.concat([
          { id: util.uid("m"), role: "assistant", content: content, at: new Date().toISOString() }
        ]);
        var g2 = store.goalById(that.data.goalId);
        var plan2 = util.clone(g2.plan);
        plan2.days[day.id].qa = finalQa;
        g2.plan = plan2;
        store.markDirtyPublic();
        that.setData({
          qaView: finalQa.map(function (m) { return { role: m.role, content: m.content }; }),
          qaStreamBlocks: []
        });
      })
      .catch(function (e) {
        renderer.cancel();
        util.toast(e.message || "答疑失败");
        that.setData({ qaStreamBlocks: [] });
      })
      .then(function () {
        that.setData({ qaBusy: false });
      });
  },

  /* ---------------- 验收（task=quiz-grade） ---------------- */

  startQuiz: function () {
    this.setData({ quizMode: "quiz" });
  },

  onAnswer: function (e) {
    var id = e.currentTarget.dataset.id;
    var answers = Object.assign({}, this.data.answers);
    answers[id] = e.detail.value;
    var all = this.data.acceptance.every(function (a) {
      return (answers[a.id] || "").trim();
    });
    this.setData({ answers: answers, canSubmitQuiz: all });
  },

  submitQuiz: function () {
    var that = this;
    var goal = store.goalById(this.data.goalId);
    var day = this.currentDay();
    if (!goal || !day || that.data.grading) return;
    var answered = that.data.acceptance.every(function (a) {
      return (that.data.answers[a.id] || "").trim();
    });
    if (!answered) {
      util.toast("每一条验收都要回答（哪怕写『不知道』也比空着诚实）");
      return;
    }
    that.setData({ grading: true });
    var ctx = JSON.stringify({
      day: day.title,
      knowledgePoints: (day.knowledgePoints || []).map(function (k) { return k.text; }),
      lesson: (day.lesson || "").slice(0, 8000),
      items: (day.acceptance || []).map(function (a) {
        return { itemId: a.id, kind: a.kind, question: a.question };
      }),
      answers: that.data.answers
    });
    chat
      .streamChat({
        task: "quiz-grade",
        args: { ctx: ctx },
        messages: [{ role: "user", content: "开始评分。" }],
        temperature: 0.3,
        onDelta: function () {}
      })
      .then(function (full) {
        var g = grade.normalizeQuizGrade(chat.extractJson(full));
        that.applyQuizResult(goal, day, g);
      })
      .catch(function (e) {
        util.toast(e.message || "评分失败，请重试");
      })
      .then(function () {
        that.setData({ grading: false });
      });
  },

  applyQuizResult: function (goal, day, g) {
    var that = this;
    var items = g.items.map(function (it) {
      var q = null;
      (day.acceptance || []).forEach(function (a) {
        if (a.id === it.itemId) q = a;
      });
      return {
        itemId: it.itemId,
        question: q ? q.question : "",
        userAnswer: that.data.answers[it.itemId] || "",
        verdict: it.verdict,
        verdictLabel: (VERDICT_LABEL[it.verdict] || VERDICT_LABEL.incorrect).label,
        verdictTone: (VERDICT_LABEL[it.verdict] || VERDICT_LABEL.incorrect).tone,
        feedback: it.feedback,
        evidence: it.evidence
      };
    });
    store.incrementAttempts(goal.id, day.id);
    if (g.overall === "pass") {
      store.setDayStatus(goal.id, day.id, "passed", {
        pendingUnlock: true,
        transferQuestion: g.transferQuestion || ""
      });
      store.logQuiz(goal.id, {
        dayId: day.id,
        date: new Date().toISOString().slice(0, 10),
        passed: true,
        forced: false,
        items: g.items.map(function (it) {
          var q = null;
          (day.acceptance || []).forEach(function (a) {
            if (a.id === it.itemId) q = a;
          });
          return {
            itemId: it.itemId,
            question: q ? q.question : "",
            userAnswer: that.data.answers[it.itemId] || "",
            verdict: it.verdict,
            feedback: it.feedback,
            hintLevel: it.hintLevel
          };
        })
      });
      var mStatus = mastery.masteryFromQuiz(
        g.items.map(function (it) {
          var kind = null;
          (day.acceptance || []).forEach(function (a) {
            if (a.id === it.itemId) kind = a.kind;
          });
          return { verdict: it.verdict, hintLevel: it.hintLevel, kind: kind };
        })
      );
      store.addLearnKnowledge(goal, day, mStatus);
      store.updatePlanKpMastery(goal.id, day.id, mStatus);
      util.toast("验收判过。答迁移题解锁下一天", "success");
    } else {
      util.toast("这遍没过。按反馈补齐再来一次");
    }
    that.setData({
      quizMode: "result",
      grade: {
        overall: g.overall,
        summary: g.summary,
        reviewAdvice: g.reviewAdvice,
        items: items,
        transferQuestion: g.transferQuestion || ""
      }
    });
    // 状态变了（passed/解锁链），整页刷新
    that.render();
    // render 会重置 quizMode 相关展示，重新置为 result 视图
    that.setData({ quizMode: "result" });
  },

  onGateInput: function (e) {
    this.setData({ gateAnswer: e.detail.value });
  },

  commitTransfer: function () {
    var that = this;
    var answer = that.data.gateAnswer.trim();
    if (!answer) return;
    store.completeTransfer(this.data.goalId, this.data.dayId, answer);
    util.toast("过关。下一天已解锁", "success");
    that.render();
    // 解锁的下一天直接切过去（与 Web onGoToDay 同语义）
    var goal = store.goalById(this.data.goalId);
    if (goal && goal.plan) {
      var day = goal.plan.days[this.data.dayId];
      var phase = null;
      goal.plan.phases.forEach(function (ph) {
        if (ph.id === day.phaseId) phase = ph;
      });
      var idx = phase ? phase.dayIds.indexOf(day.id) : -1;
      var nextId = idx >= 0 ? phase.dayIds[idx + 1] : "";
      if (nextId && goal.plan.days[nextId] && goal.plan.days[nextId].status === "active") {
        wx.redirectTo({
          url: "/pages/day/day?goalId=" + this.data.goalId + "&dayId=" + nextId
        });
      }
    }
  },

  onSkipInput: function (e) {
    this.setData({ skipText: e.detail.value });
  },

  forceSkip: function () {
    var that = this;
    if (that.data.skipText.trim() !== "跳过") {
      util.toast("在输入框输入「跳过」确认");
      return;
    }
    store.setDayStatus(this.data.goalId, this.data.dayId, "skipped");
    store.logQuiz(this.data.goalId, {
      dayId: this.data.dayId,
      date: new Date().toISOString().slice(0, 10),
      passed: false,
      forced: true,
      items: []
    });
    util.toast("已跳过。解锁了下一天，继续。", "success");
    var goal = store.goalById(this.data.goalId);
    if (goal && goal.plan) {
      var day = goal.plan.days[this.data.dayId];
      var phase = null;
      goal.plan.phases.forEach(function (ph) {
        if (ph.id === day.phaseId) phase = ph;
      });
      var idx = phase ? phase.dayIds.indexOf(day.id) : -1;
      var nextId = idx >= 0 ? phase.dayIds[idx + 1] : "";
      if (nextId && goal.plan.days[nextId] && goal.plan.days[nextId].status === "active") {
        wx.redirectTo({
          url: "/pages/day/day?goalId=" + this.data.goalId + "&dayId=" + nextId
        });
        return;
      }
    }
    that.render();
  },

  backToLearn: function () {
    this.setData({ quizMode: "learn", grade: null });
  }
});
