var store = require("../../utils/store.js");
var chat = require("../../utils/chat.js");
var grade = require("../../utils/grade.js");
var mastery = require("../../utils/mastery.js");
var md = require("../../utils/md.js");
var util = require("../../utils/util.js");
var schema = require("../../utils/schema.js");
var streamView = require("../../utils/stream-view.js");
var sessionGuard = require("../../utils/session.js");
/* assistant→blocks / user→content 的视图映射（此前在本页复制了四处，
 * 漏改一处就让整段历史变空白卡片）。统一走 utils/chat-view.js。 */
var chatView = require("../../utils/chat-view.js");

var VERDICT_LABEL = {
  correct: { label: "过", tone: "ok" },
  partially_correct: { label: "部分", tone: "warn" },
  incorrect: { label: "不对", tone: "bad" },
  ungradable: { label: "不计", tone: "dim" }
};

/* 验收题类型的中文徽标（schema 枚举：explain/apply/oral/essay/build） */
var KIND_LABEL = {
  explain: "讲解",
  apply: "应用",
  oral: "口述",
  essay: "写作",
  build: "构建"
};

/* 按 itemId 在 day.acceptance 里找题（applyQuizResult 此前同样的循环复制了三遍） */
function acceptanceOf(day, itemId) {
  var hit = null;
  (day.acceptance || []).forEach(function (a) {
    if (a.id === itemId) hit = a;
  });
  return hit;
}

Page({
  data: {
    goalId: "",
    dayId: "",
    day: null,
    goalTopic: "",
    readOnly: false,
    tab: "lesson",
    detailBusy: false,
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
    var that = this;
    /* 收藏/分享/历史路径直达时 store.userId 还没恢复（me() 探测 + 全量快照在途）：
     * 旧实现直接 render → currentDay() 返回 null → 立刻弹「内容不存在」假错误模态，
     * 用户面对的其实是恢复中的 loading 态却被要求在「返回/留在此页」间做决定。
     * 与 book.js/council.js 同一守卫：恢复成功后再渲染；探测失败有 session.js 的
     * 「重试/暂不」模态兜底，不再把「数据还在恢复中」误报成「内容已删除」。 */
    sessionGuard.ensure(function () {
      that.render();
    });
  },

  /* 流式中退出本页：中止在途请求，别让它跑到 180s 超时、对死页 setData */
  onUnload: function () {
    if (this._cancelLesson) this._cancelLesson();
    if (this._cancelQa) this._cancelQa();
    if (this._cancelGrade) this._cancelGrade();
    if (this._cancelDetail) this._cancelDetail();
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
      /* 旧实现只弹 2.4s toast 后整页留白，且每次 onShow 重复弹；
       * 改为模态明确告知并给返回出口（每次进页只提示一次）。 */
      if (!this._missingWarned) {
        this._missingWarned = true;
        wx.showModal({
          title: "内容不存在",
          content: "目标或学习日可能已被删除。",
          confirmText: "返回",
          cancelText: "留在此页",
          success: function (res) {
            if (res.confirm) wx.navigateBack();
          }
        });
      }
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
      cache._qaView = chatView.toChatView(day.qa || []);
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
    var patch = {
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
        /* 模板按 item.kindLabel 渲染徽标：缺这个字段每张题卡都是空徽标（同页 resources 早有映射） */
        return {
          id: a.id,
          kind: a.kind,
          kindLabel: KIND_LABEL[a.kind] || "验收",
          question: a.question,
          hint: a.hint || ""
        };
      }),
      gateQuestion: day.transferQuestion || ""
    };
    /* gateAnswer 与 answers/skipText/qaInput 同一保留纪律：只在首次渲染（或换到
     * 另一个目标/学习日）时从 store 初始化；此后 render（onShow 回前台、从模态
     * 返回、讲义生成完成）不得覆盖进行中的作答——迁移门答到一半切去微信再回来
     * 即被清空重打。commitTransfer 落库后 transferAnswer 与输入一致，不受影响。 */
    var gateKey = this.data.goalId + "/" + this.data.dayId;
    if (this._gateKey !== gateKey) {
      this._gateKey = gateKey;
      patch.gateAnswer = day.transferAnswer || "";
    }
    this.setData(patch);
  },

  copyCode: function (e) {
    /* 复制反馈统一走 util.copyText（council/book/note 同一口径，见 util.js 注释） */
    util.copyText(e.currentTarget.dataset.code || "", "代码已复制");
  },

  /* ---------------- 目录占位展开（task=plan mode=phase-detail，单日） ----------------
   * 目录只给了标题与知识点；学到那天再按需展开资料/方法/验收（与 Web expandDay 同链路）。 */
  expandDetail: function () {
    var that = this;
    var goal = store.goalById(this.data.goalId);
    var day = this.currentDay();
    if (!goal || !day || !day.stub || that.data.detailBusy) return;
    var phase = null;
    goal.plan.phases.forEach(function (ph) {
      if (ph.id === day.phaseId) phase = ph;
    });
    if (!phase) return;
    that.setData({ detailBusy: true });
    var c = schema.buildPhaseCtx(goal, phase);
    var daysJson = JSON.stringify([
      { title: day.title, knowledgePoints: (day.knowledgePoints || []).map(function (kp) { return kp.text; }) }
    ]);
    chat
      .streamChat({
        task: "plan",
        args: { mode: "phase-detail", ctx: c.ctx, boundary: phase.boundary || "", days: daysJson },
        messages: [{ role: "user", content: "为指定的这一天写出完整细节（只要 JSON）。" }],
        register: function (cancel) {
          that._cancelDetail = cancel;
        },
        onDelta: function () {}
      })
      .then(function (full) {
        var parsed = chat.extractJson(full);
        /* 模型可能只给单日对象而非 days 数组——两种形状都收（与 Web schema 容错同纪律） */
        var list = parsed && Array.isArray(parsed.days) ? parsed.days : [parsed];
        if (!list.length || !list[0]) throw new Error("这一天没拿到细节，请重试");
        var built = schema.phaseDraftToDay(list[0], day.phaseId, day.id);
        /* 写失败（生成 10-30s 期间目标被他端删除/adoptCloud 替换）不能报成功：
         * setDayDetail 对不存在的落点是静默空操作（与 commitTransfer/forceSkip
         * 的布尔返回值纪律同一收口），旧实现无条件 toast「已就绪」，紧接着 render
         * 弹「内容不存在」模态，反馈自相矛盾。 */
        if (!store.setDayDetail(that.data.goalId, day.phaseId, day.id, built)) {
          util.toast("目标或学习日已被删除，这次展开没能保存");
          that.render();
          return;
        }
        util.toast("今天的计划已就绪", "success");
        that.render();
      })
      .catch(function (e) {
        util.toast(e.message || "展开失败，稍后再试");
      })
      .then(function () {
        that.setData({ detailBusy: false });
      });
  },

  copyLink: function (e) {
    var url = e.currentTarget.dataset.url || "";
    if (!url) return;
    util.copyText(url, "链接已复制，去浏览器打开");
  },

  copyAllLinks: function () {
    var urls = this.data.links
      .map(function (l) { return l.url; })
      .filter(function (u) { return u; });
    if (!urls.length) return;
    /* 反馈只在 success 里报：剪贴板被拒时不能骗人（util.copyText 已收口） */
    util.copyText(urls.join("\n"), urls.length + " 条链接已复制");
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
        (d.knowledgePoints || []).forEach(function (kp) {
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
        register: function (cancel) {
          that._cancelLesson = cancel;
        },
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
          that.saveLesson(day, text);
        } else {
          util.toast("生成内容为空，稍后再试");
        }
      })
      .catch(function (e) {
        renderer.cancel();
        if (buf.trim().length > 200) {
          /* 保存结果决定文案：落点已消失时不能谎称「已保留已生成的内容」
           * （saveLesson 失败时已给出自己的提示）。 */
          if (that.saveLesson(day, buf)) {
            util.toast("生成中断，已保留已生成的内容");
          }
        } else {
          util.toast(e.message || "生成失败");
        }
      })
      .then(function () {
        that.setData({ lessonBusy: false });
      });
  },

  /* 讲义落库：写路径收口在 store.saveDayLesson（与 setDayStatus 同一签名纪律，
   * 返回「是否真的写入」）。生成讲义耗时 40-90s，期间 pullIfSafe→adoptCloud 可能
   * 已整体替换 goals 或删掉这一天——落点消失时必须给可见交代，不能让用户看着
   * 流式渲染完的讲义在成功回调后凭空消失（sendQa/qaFail/applyQuizResult 同口径）。 */
  saveLesson: function (day, text) {
    if (!store.saveDayLesson(this.data.goalId, day.id, text)) {
      util.toast("目标或学习日已被删除，这份讲义没能保存");
      this.render();
      return false;
    }
    this.render();
    return true;
  },

  /* 页面内停止入口：讲义 40-90s、判分 10-60s 期间此前只能离开页面才能中止——
   * 这些是真实计费的 BYOK 调用，点错章节后既不能中断也省不了消耗。与 onUnload
   * 同一收口：cancel 由 chat 层注册，reject 后走各自的 catch 分支（讲义保留
   * 半截内容并如实提示、busy 复位）。 */
  stopLesson: function () {
    if (this.data.lessonBusy && this._cancelLesson) this._cancelLesson();
  },

  stopGrade: function () {
    if (this.data.grading && this._cancelGrade) this._cancelGrade();
  },

  stopQa: function () {
    if (this.data.qaBusy && this._cancelQa) this._cancelQa();
  },

  /* ---------------- 答疑（task=coach-qa，流式） ---------------- */

  onQaInput: function (e) {
    this.setData({ qaInput: e.detail.value });
  },

  /* 答疑自动滚底（book/council 同诉求）：day 的答疑区在页面流里，不是独立
   * scroll-view，用 selectorQuery 量锚点位置再 pageScrollTo，兼容不支持
   * selector 参数的老基础库。滚底是体验增强不是关键路径：API 不可用（含测试
   * 环境）时静默跳过。 */
  scrollQaBottom: function () {
    if (
      typeof wx.createSelectorQuery !== "function" ||
      typeof wx.pageScrollTo !== "function"
    ) {
      return;
    }
    var query = wx.createSelectorQuery();
    query.select("#qa-bottom").boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec(function (res) {
      var rect = res && res[0];
      var vp = res && res[1];
      if (!rect || !vp) return;
      wx.pageScrollTo({ scrollTop: vp.scrollTop + rect.top, duration: 200 });
    });
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
    /* 每日答疑无限追加会撞穿 4.2MB 同步闸与单 key 1MB 存储上限（store.js 的
     * quizLog 已因同一原因修过）：上限与文案见 util.capMessages。 */
    qa = util.capMessages(qa);
    /* 写路径收口在 store.setDayQa（与 setDayStatus 同一签名纪律，返回「是否真的
     * 写入」）：此前页面层手写 clone→改→assign 的旁路写法在本页复制了三份，
     * 永远拿不到写入失败信号。 */
    if (!store.setDayQa(this.data.goalId, day.id, qa)) {
      /* 落点没了（他端已删目标/学习日）：提问不落库、也不发后续计费调用 */
      util.toast("目标或学习日已被删除，这条提问没能保存");
      that.setData({ qaBusy: false });
      return;
    }
    that.setData({
      /* assistant 消息必须带 blocks（模板按 blocks 渲染），统一走 utils/chat-view.js */
      qaView: chatView.toChatView(qa)
    });
    that.scrollQaBottom();
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
        register: function (cancel) {
          that._cancelQa = cancel;
        },
        onDelta: function (d) {
          stream += d;
          renderer.push();
        }
      })
      .then(function (full) {
        renderer.flush();
        var content = full || stream;
        var finalQa = util.capMessages(
          qa.concat([
            { id: util.uid("m"), role: "assistant", content: content, at: new Date().toISOString() }
          ])
        );
        /* 写路径收口在 store.setDayQa：答疑流 10-60s+，期间他端删目标/adoptCloud
         * 整体替换 goals 后落点可能已消失——没有落点就明确告知，不能让用户看到
         * "提问后永远没有回答"（旧实现的 clone 旁路写在 goal 已换时还会抛
         * TypeError）。store 内部写前重取引用，落库一定落在当前 state 上。 */
        if (!store.setDayQa(that.data.goalId, day.id, finalQa)) {
          util.toast("目标或学习日已被删除，这条回答没能保存");
          that.setData({ qaStreamBlocks: [] });
          return;
        }
        that.setData({
          /* 与 render() 同一份映射（utils/chat-view.js）：此前这处漏改，
           * 回答一到整段历史又变空白卡片。 */
          qaView: chatView.toChatView(finalQa),
          qaStreamBlocks: []
        });
        that.scrollQaBottom();
      })
      .catch(function (e) {
        renderer.cancel();
        that.qaFail(day.id, e);
        that.setData({ qaStreamBlocks: [] });
      })
      .then(function () {
        that.setData({ qaBusy: false });
      });
  },

  /* 答疑失败落持久标记：用户消息已入库，只弹 2.4s toast 会让人以为已获回复；
   * 有半截增量就保留（与讲义同一保留策略），再附失败说明。 */
  qaFail: function (dayId, e) {
    var that = this;
    var g = store.goalById(this.data.goalId);
    /* 目标/学习日已被他端删掉时无处落失败标记：但用户消息已入库，
     * 静默 return 就是"提问后永远没有回答"，必须给一句可见的交代。 */
    if (!g || !g.plan || !g.plan.days[dayId]) {
      util.toast("目标或学习日已被删除，这条回答没能保存");
      return;
    }
    var partial = (e && e.partial) || "";
    var content = partial
      ? "（生成中断，以下是已生成的部分）\n\n" + partial
      : "（本次回答生成失败" + (e && e.message ? "：" + e.message : "") + "。请重新提问重试。）";
    var qa = util.capMessages(
      (g.plan.days[dayId].qa || []).concat([
        {
          id: util.uid("m"),
          role: "assistant",
          content: content,
          failed: true,
          at: new Date().toISOString()
        }
      ])
    );
    /* 写路径收口在 store.setDayQa：检查之后写入之前落点仍可能消失，
     * 布尔返回值保证这里也不会对空操作视而不见。 */
    if (!store.setDayQa(this.data.goalId, dayId, qa)) {
      util.toast("目标或学习日已被删除，这条回答没能保存");
      return;
    }
    that.setData({
      qaView: chatView.toChatView(qa)
    });
    util.toast((e && e.message) || "答疑失败");
  },

  /* ---------------- 验收（task=quiz-grade） ---------------- */

  startQuiz: function () {
    this.setData({ quizMode: "quiz" });
  },

  onAnswer: function (e) {
    var id = e.currentTarget.dataset.id;
    var value = e.detail.value;
    /* 路径更新：旧实现每次输入都把整张 answers 表（含所有长文答案）全量 setData，
     * 长答案时每敲一个字都要跨线程序列化一遍，输入发卡。 */
    var patch = {};
    patch["answers." + id] = value;
    var answers = Object.assign({}, this.data.answers);
    answers[id] = value;
    patch.canSubmitQuiz = this.data.acceptance.every(function (a) {
      return (answers[a.id] || "").trim();
    });
    this.setData(patch);
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
        register: function (cancel) {
          that._cancelGrade = cancel;
        },
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
    /* 写前重取引用（与 saveLesson/sendQa 同纪律）：quiz-grade 是 10-60s 的非流式等待，
     * 期间 pullIfSafe 可能已 adoptCloud 整体替换 goals。旧实现沿用提交时的 goal/day：
     * store.applyQuizPass/logQuiz 按 id 重查后对失效数据静默 return，addLearnKnowledge
     * 却仍用旧 goal/day 把知识点写进第二大脑——attempts/passed/迁移门/quizLog 全没写，
     * 知识点却入库，UI 还报「验收判过」。这里统一以当前 state 为准，没有落点就明确告知。 */
    var g2 = store.goalById(this.data.goalId);
    var d2 = g2 && g2.plan ? g2.plan.days[this.data.dayId] : null;
    var alive = Boolean(g2 && d2);
    /* 结果页仍按当前数据渲染（拿不到新引用时退回提交时的快照，至少让反馈可见） */
    var viewDay = d2 || day;
    var items = g.items.map(function (it) {
      var q = acceptanceOf(viewDay, it.itemId);
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
    if (g.overall === "pass" && !alive) {
      /* 没有落点就绝不报「判过」：写路径会静默空操作，用户回列表发现进度没动 */
      util.toast("目标或学习日已被删除，这次验收没能保存");
    } else if (g.overall === "pass") {
      var mStatus = mastery.masteryFromQuiz(
        g.items.map(function (it) {
          var a = acceptanceOf(viewDay, it.itemId);
          return { verdict: it.verdict, hintLevel: it.hintLevel, kind: a ? a.kind : null };
        })
      );
      /* 一次 clone 写全 attempts/passed/迁移门/掌握度：
       * 原先 incrementAttempts → setDayStatus → updatePlanKpMastery 三步串行三次深拷贝。 */
      store.applyQuizPass(g2.id, d2.id, mStatus, g.transferQuestion || "");
      store.logQuiz(g2.id, {
        dayId: d2.id,
        date: new Date().toISOString().slice(0, 10),
        passed: true,
        forced: false,
        items: g.items.map(function (it) {
          var q = acceptanceOf(viewDay, it.itemId);
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
      store.addLearnKnowledge(g2, d2, mStatus);
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
    // 状态变了（passed/解锁链），整页刷新（render 不碰 quizMode，上面这次 setData 已经是 result 视图）
    that.render();
  },

  onGateInput: function (e) {
    this.setData({ gateAnswer: e.detail.value });
  },

  /* 解锁跳转（commitTransfer/forceSkip 此前整段复制）：下一天已 active 就 redirect 过去 */
  goNextDayIfUnlocked: function () {
    var self = this;
    var goal = store.goalById(this.data.goalId);
    if (goal && goal.plan) {
      var day = goal.plan.days[this.data.dayId];
      /* day 被 adoptCloud 换掉时这里会是 undefined：下面的 day.phaseId 会抛
       * TypeError（本函数在 commitTransfer/forceSkip 的 toast 之后调用）。 */
      if (!day) return false;
      var phase = null;
      goal.plan.phases.forEach(function (ph) {
        if (ph.id === day.phaseId) phase = ph;
      });
      var idx = phase ? phase.dayIds.indexOf(day.id) : -1;
      var nextId = idx >= 0 ? phase.dayIds[idx + 1] : "";
      if (nextId && goal.plan.days[nextId] && goal.plan.days[nextId].status === "active") {
        wx.redirectTo({
          url: "/pages/day/day?goalId=" + self.data.goalId + "&dayId=" + nextId
        });
        return true;
      }
    }
    return false;
  },

  commitTransfer: function () {
    var answer = this.data.gateAnswer.trim();
    /* 空答案必须有可见反馈：这是迁移门 hero 上唯一的主动作，静默 return 最容易被
     * 当成「卡死」（与 submitQuiz 空答案 toast、saveDeposit「写一句话再存」同口径；
     * wxml 侧另有 disabled 视觉态 + bindtap 门控，这里兜住纯空白输入）。 */
    if (!answer) {
      util.toast("先写下你的回答再提交过关");
      return;
    }
    /* 写失败（目标/学习日已被他端删除）不能报「过关」：store 对不存在的 day
     * 是静默空操作，旧实现无条件 toast 成功 + 跳下一天。 */
    if (!store.completeTransfer(this.data.goalId, this.data.dayId, answer)) {
      util.toast("目标或学习日已被删除，这一步没保存");
      this.render();
      return;
    }
    util.toast("过关。下一天已解锁", "success");
    this.render();
    // 解锁的下一天直接切过去（与 Web onGoToDay 同语义）
    this.goNextDayIfUnlocked();
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
    /* 写失败（目标/学习日已被他端删除）不能报「已跳过」：store 对不存在的 day
     * 是静默空操作，旧实现无条件 toast 成功，用户以为推进了其实什么都没发生。 */
    if (!store.setDayStatus(this.data.goalId, this.data.dayId, "skipped")) {
      util.toast("目标或学习日已被删除，这一步没保存");
      that.render();
      return;
    }
    store.logQuiz(this.data.goalId, {
      dayId: this.data.dayId,
      date: new Date().toISOString().slice(0, 10),
      passed: false,
      forced: true,
      items: []
    });
    util.toast("已跳过。解锁了下一天，继续。", "success");
    if (!this.goNextDayIfUnlocked()) that.render();
  },

  backToLearn: function () {
    this.setData({ quizMode: "learn", grade: null });
  }
});
