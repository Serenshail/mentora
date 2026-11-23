var store = require("../../utils/store.js");
var chat = require("../../utils/chat.js");
var modes = require("../../utils/modes.js");
var schema = require("../../utils/schema.js");
var md = require("../../utils/md.js");
var util = require("../../utils/util.js");
var streamView = require("../../utils/stream-view.js");
var sessionGuard = require("../../utils/session.js");
/* assistant→blocks 的视图映射与 day/council 共用一份实现（utils/chat-view.js） */
var toChatView = require("../../utils/chat-view.js").toChatView;

/* 读书页 = 五模式对话 + 阅读系统 V1.0（认知地图/阅读目标/三重验收/五态状态机/沉淀）。
 * 与 Web /read/[id] 同链路同数据：assessment/deposit/readStatus 落库后 Web 端直接可读。 */

var VERDICT_TONE = {
  mastered: { label: "过", cls: "badge-ok" },
  partial: { label: "部分", cls: "badge-warn" },
  not: { label: "没过", cls: "badge-bad" },
  ungradable: { label: "不计", cls: "badge-dim" }
};

/* 聊天视图签名：render 在 onShow 与几乎每次点击（换读法/选目标/验收/沉淀）后都会跑，
 * 而聊天记录随使用无界增长——每次全量 md.parse 是低端机上可感的点击卡顿。
 * 消息只追加不改写，所以「条数 + 总字数 + 末条尾部采样」足以判定内容是否变了
 * （day.js:126-140 / brain.js:68-76 的同一条缓存纪律，book 此前漏配）。 */
function chatViewSig(messages) {
  var totalLen = 0;
  for (var i = 0; i < messages.length; i++) {
    totalLen += (messages[i].content || "").length;
  }
  var last = messages.length ? messages[messages.length - 1].content || "" : "";
  return messages.length + "|" + totalLen + "|" + last.slice(-40);
}

Page({
  data: {
    book: null,
    /* 会话恢复中：直达页 onShow 走 session.ensure（me() + 全量快照，弱网可达数秒），
     * 期间不能渲染「书不存在」假空态——用户会以为书被删了
     * （council.booting / brain.loading / profile.booting 的同款守卫）。 */
    booting: true,
    chapter: null,
    mode: null,
    modes: modes.MODES,
    chatView: [],
    input: "",
    busy: false,
    streamBlocks: [],
    showModes: false,
    showChapters: false,
    chapters: [],
    doneCount: 0,
    masteredCount: 0,
    toBottom: "",
    navH: "",
    /* ---- 阅读系统 V1.0 ---- */
    showOverview: false, // 认知概览（地图+目标+状态机）默认收起
    map: null,
    mapFields: [],
    verifyLabel: "",
    goalView: null, // {primaryLabel, chips:[{id,label,on,primary}]}
    readStatus: "",
    readStatusLabel: "",
    readStatusTone: "dim",
    wholeDone: 0,
    /* 验收流 */
    assessOpen: false,
    assessBusy: false,
    assessChapterTitle: "",
    assessQuestions: [],
    assessAnswers: [],
    assessResult: null, // {rows:[{kindLabel,levelLabel,levelCls,feedback,evidence}], suggestion, allMastered}
    /* 沉淀 */
    showDeposits: false,
    depositTypes: schema.DEPOSIT_TYPES,
    depositType: "point",
    depositText: "",
    deposits: [],
    /* AI 推荐阅读目标的忙碌位：与验收流分开（此前共用 assessBusy，推荐在途时
     * 所有验收入口的 tap 被静默吞掉，无任何反馈）。 */
    goalBusy: false,
    recapBusy: false,
    recap: null, // {chapterId, title, blocks}
    recapSaving: false
  },

  onLoad: function (query) {
    this.bookId = query.bookId;
  },

  onShow: function () {
    var that = this;
    /* 收藏/分享直达时 store 还没恢复（userId 为 null、books 为空）：
     * 旧实现直接 render → 「书不存在」空态，而数据其实在本地/云端，
     * 且本页没有任何自愈路径。统一走 session.ensure，恢复后再渲染。 */
    sessionGuard.ensure(function () {
      that.render();
    });
  },

  onUnload: function () {
    if (this._cancelStream) this._cancelStream();
    if (this._cancelAssess) this._cancelAssess();
    if (this._cancelGoal) this._cancelGoal();
    if (this._cancelRecap) this._cancelRecap();
  },

  chapterView: function (b, chapter) {
    return {
      id: chapter.id,
      index: b.chapters.indexOf(chapter) + 1,
      title: chapter.title,
      focusQuestion: chapter.focusQuestion || "",
      coreIdea: chapter.coreIdea || "",
      knowledgeType: chapter.knowledgeType || "concept",
      status: chapter.status,
      mastered: Boolean(chapter.masteredAt),
      keyConcepts: chapter.keyConcepts || []
    };
  },

  mapView: function (map) {
    if (!map || (!map.coreProblem && !map.authorStance && !map.lineage && !map.controversies)) return null;
    return [
      { k: "它在解决什么问题", v: map.coreProblem || "" },
      { k: "作者的主张", v: map.authorStance || "" },
      { k: "思想谱系", v: map.lineage || "" },
      { k: "争议与局限", v: map.controversies || "" }
    ].filter(function (f) { return f.v; });
  },

  goalToView: function (goal) {
    var labels = schema.READING_GOAL_LABELS;
    var primary = (goal && goal.primary) || "";
    var secondary = (goal && goal.secondary) || [];
    var chips = ["understand", "think", "apply", "retain"].map(function (id) {
      return {
        id: id,
        label: labels[id],
        primary: id === primary,
        on: id === primary || secondary.indexOf(id) >= 0
      };
    });
    return {
      set: Boolean(goal),
      inferred: Boolean(goal && goal.inferred),
      primaryLabel: labels[primary] || "",
      intent: (goal && goal.intent) || "",
      chips: chips
    };
  },

  render: function () {
    var b = store.bookById(this.bookId);
    if (!b) {
      /* 恢复完还找不到书才是真不存在：撤掉 booting，显示「书不存在」空态 */
      this.setData({ book: null, booting: false });
      return;
    }
    var chapter = this.currentChapterId ? store.findChapter(b, this.currentChapterId) : null;
    if (!chapter) {
      chapter =
        b.chapters.filter(function (c) { return c.status === "todo"; })[0] || b.chapters[0] || null;
    }
    var modeId = b.chatMode || modes.defaultMode(chapter && chapter.knowledgeType);
    /* 解析缓存挂页面实例（跟着页面生命周期走），键 = 聊天内容签名：
     * 内容没变就复用上次的 blocks，别在每次点击时重解析整段历史。 */
    var msgs = b.chat || [];
    var chatSig = chatViewSig(msgs);
    if (this._chatSig !== chatSig) {
      this._chatSig = chatSig;
      this._chatView = toChatView(msgs);
    }
    var chatView = this._chatView;
    var doneCount = b.chapters.filter(function (c) { return c.status === "done"; }).length;
    var masteredCount = b.chapters.filter(function (c) { return c.masteredAt; }).length;
    var readStatus = b.readStatus || (b.status === "done" ? "finished" : b.status === "reading" ? "reading" : "unread");
    var verifyLabel = "";
    if (b.verification === "verified") verifyLabel = "已核实";
    else if (b.verification === "user_material") verifyLabel = "基于你的材料";

    /* 标题由自绘 nav-bar 展示（app.json 全局 navigationStyle: custom）：
     * wx.setNavigationBarTitle 在这套导航下没有可见效果，且 b.title.slice 是
     * render 里未兜底的字段访问（云端脏快照可能缺 title）。note 页同款已删。 */
    this.setData({
      booting: false,
      book: {
        id: b.id,
        title: b.title,
        author: b.author || "",
        planSummary: b.planSummary || "",
        modeJustSwitched: Boolean(b.modeJustSwitched)
      },
      chapter: chapter ? this.chapterView(b, chapter) : null,
      mode: modes.byId(modeId),
      chatView: chatView,
      doneCount: doneCount,
      masteredCount: masteredCount,
      map: this.mapView(b.map),
      verifyLabel: verifyLabel,
      goalView: this.goalToView(b.goal),
      readStatus: readStatus,
      readStatusLabel: schema.READ_STATUS_LABELS[readStatus] || "未开始",
      readStatusTone: readStatus === "mastered" ? "ok" : readStatus === "assessing" ? "accent" : readStatus === "finished" ? "warn" : "dim",
      chapters: b.chapters.map(function (c, i) {
        return {
          id: c.id,
          title: c.title,
          status: c.status,
          index: i + 1,
          mastered: Boolean(c.masteredAt)
        };
      }),
      deposits: (b.deposits || []).map(function (d) {
        var label = "";
        schema.DEPOSIT_TYPES.forEach(function (t) {
          if (t.id === d.type) label = t.label;
        });
        return { id: d.id, typeLabel: label, text: d.text };
      })
    });
    this.scrollBottom();
  },

  scrollBottom: function () {
    var that = this;
    wx.nextTick(function () {
      /* scroll-into-view 只在值变化时才触发滚动：恒设同一个值的话，从第二条
       * 消息起 setData 被 diff 掉，用户新消息与 AI 回复都不会自动滚入视口。
       * 先置空再赋值，保证每次都是一次有效变化。 */
      that.setData({ toBottom: "" });
      wx.nextTick(function () {
        that.setData({ toBottom: "chat-bottom" });
      });
    });
  },

  /* 页面内停止入口：读伴对话是真实计费的 BYOK 流式调用，此前 busy 期间输入框
   * 被禁用且无停止键，唯一的中止手势是退出页面（用户看不见）。取消后走 send
   * 的 catch：保留半截内容、落持久失败标记、复位 busy。 */
  stopChat: function () {
    if (this.data.busy && this._cancelStream) this._cancelStream();
  },

  toggleModes: function () {
    this.setData({ showModes: !this.data.showModes, showChapters: false });
  },

  toggleChapters: function () {
    this.setData({ showChapters: !this.data.showChapters, showModes: false });
  },

  toggleOverview: function () {
    this.setData({ showOverview: !this.data.showOverview });
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
    if (!b) return;
    var c = store.findChapter(b, id);
    if (!c) return;
    this.currentChapterId = id;
    this.setData({ showChapters: false, chapter: this.chapterView(b, c) });
  },

  onInput: function (e) {
    this.setData({ input: e.detail.value });
  },

  /* ---------------- 认知地图 + 阅读目标 ---------------- */

  /* AI 推荐阅读目标（task=reading-goal）：失败静默，用户可手动点四成果 chip。
   * 忙碌位用本流专用的 goalBusy：此前复用验收面板的 assessBusy，推荐在途（数秒
   * 网络往返）时所有验收入口的 tap 被 openAssess 的同标志拦截静默吞掉，无 toast
   * 无面板——两类互不相干的异步流程不该共用一个 busy 位。 */
  recommendGoal: function () {
    var that = this;
    var b = store.bookById(this.bookId);
    if (!b || that.data.goalBusy) return;
    that.setData({ goalBusy: true });
    chat
      .streamChat({
        task: "reading-goal",
        args: { title: b.title, author: b.author || "", desc: b.planSummary || "" },
        messages: [{ role: "user", content: "推荐阅读目标。" }],
        register: function (cancel) {
          that._cancelGoal = cancel;
        },
        onDelta: function () {}
      })
      .then(function (full) {
        var g = schema.normReadingGoal(chat.extractJson(full));
        store.updateBook(that.bookId, {
          goal: {
            primary: g.primary,
            secondary: g.secondary,
            intent: "",
            background: "",
            inferred: true,
            setAt: new Date().toISOString()
          }
        });
        util.toast("已按这本书推荐：" + (schema.READING_GOAL_LABELS[g.primary] || "理解"), "success");
        that.render();
      })
      .catch(function () {
        util.toast("推荐没成功，可以直接点下面四个目标");
      })
      .then(function () {
        that.setData({ goalBusy: false });
      });
  },

  /* 用户改目标：点即设主目标；目标变化不清任何已有记录（Web 同纪律） */
  pickGoalChip: function (e) {
    var id = e.currentTarget.dataset.id;
    var b = store.bookById(this.bookId);
    if (!b) return;
    var old = b.goal || {};
    var secondary = (old.secondary || []).filter(function (s) { return s !== id; });
    if (old.primary === id) return; // 主目标没变，忽略
    if (old.primary) secondary = [old.primary].concat(secondary);
    store.updateBook(this.bookId, {
      goal: {
        primary: id,
        secondary: secondary.slice(0, 2),
        intent: old.intent || "",
        background: old.background || "",
        inferred: false,
        setAt: new Date().toISOString()
      }
    });
    this.render();
  },

  /* ---------------- 三重验收（reading-assess-gen / grade） ---------------- */

  /* 出题失败本地兜底三题（与 Web 同文案），不阻断验收 */
  openAssess: function (e) {
    var that = this;
    var chapterId = e.currentTarget.dataset.id || (this.data.chapter && this.data.chapter.id);
    var b = store.bookById(this.bookId);
    if (!b || that.data.assessBusy) return;
    var c = store.findChapter(b, chapterId);
    if (!c) return;
    this.currentChapterId = chapterId;
    /* 被验收章单独记在实例上：提交（submitAssess）必须用面板打开时选中的章。
     * 旧实现从目录弹层对非当前章点「验收」时只改 currentChapterId，
     * submitAssess 却读 data.chapter（仍是旧展示章）→ 判分上下文、逐题档案、
     * masteredAt 全部落到错误的章上。 */
    this.assessChapterId = chapterId;
    /* 必须清掉上一章残留的标题与题目：出题是网络往返（数秒），等待期面板
     * 若还渲染上一章的题，用户会对着旧题作答（提交被 assessBusy 挡下，但困惑已产生）；
     * 首开时则是一块只有标题和提交按钮的空面板。模板据 assessBusy 显示「正在出题」。 */
    that.setData({
      showChapters: false,
      assessBusy: true,
      assessOpen: true,
      assessResult: null,
      assessChapterTitle: c.title,
      assessQuestions: [],
      assessAnswers: []
    });
    /* 之前没过的反馈当 previousWeak 传给出题器（Web previousWeak 同语义） */
    var weak = (b.assessments || [])
      .filter(function (a) { return a.chapterId === chapterId && a.level !== "mastered"; })
      .slice(-2)
      .map(function (a) { return schema.ASSESS_KIND_LABELS[a.kind] + "：" + a.feedback; })
      .join("；");
    var gen = function () {
      return chat.streamChat({
        task: "reading-assess-gen",
        args: {
          book: b.title,
          chapter: schema.chapterJson(c),
          goal: schema.goalText(b.goal),
          previousWeak: weak
        },
        messages: [{ role: "user", content: "出验收题。" }],
        temperature: 0.4,
        register: function (cancel) {
          that._cancelAssess = cancel;
        },
        onDelta: function () {}
      });
    };
    gen()
      .then(function (full) {
        var g = schema.normAssessGen(chat.extractJson(full));
        return g.questions;
      })
      .catch(function () {
        util.toast("在线出题没成功，用了通用三题。");
        return schema.fallbackAssessQuestions(c);
      })
      .then(function (questions) {
        that.setData({
          assessBusy: false,
          assessChapterTitle: c.title,
          assessQuestions: questions,
          assessAnswers: questions.map(function () { return ""; })
        });
      });
  },

  onAssessInput: function (e) {
    var i = e.currentTarget.dataset.i;
    var patch = {};
    patch["assessAnswers[" + i + "]"] = e.detail.value;
    this.setData(patch);
  },

  closeAssess: function () {
    if (this.data.assessBusy) return;
    /* 题目/标题一并清掉：留着的话下次打开别的章节会先闪上一章的内容 */
    this.setData({
      assessOpen: false,
      assessResult: null,
      assessChapterTitle: "",
      assessQuestions: [],
      assessAnswers: []
    });
  },

  submitAssess: function () {
    var that = this;
    var b = store.bookById(this.bookId);
    if (!b || that.data.assessBusy) return;
    var answers = that.data.assessAnswers;
    var incomplete = answers.some(function (a) { return !(a || "").trim(); });
    if (incomplete) {
      util.toast("三题都要写，验收才算数。");
      return;
    }
    /* 用面板打开时记录的被验收章（this.assessChapterId），而不是当前展示章
     * data.chapter——从目录对非当前章发起验收时两者不同，档案与掌握状态
     * 曾被写到旧展示章名下（判分请求的章节上下文同样错配）。 */
    var chapterId = this.assessChapterId || (that.data.chapter && that.data.chapter.id);
    var c = chapterId ? store.findChapter(b, chapterId) : null;
    if (!c) return;
    that.setData({ assessBusy: true });
    var qa = that.data.assessQuestions.map(function (q, i) {
      return { kind: q.kind, question: q.question, answer: answers[i] };
    });
    chat
      .streamChat({
        task: "reading-assess-grade",
        args: {
          book: b.title,
          chapter: schema.chapterJson(c),
          goal: schema.goalText(b.goal),
          qa: JSON.stringify(qa)
        },
        messages: [{ role: "user", content: "评分。" }],
        temperature: 0.2,
        register: function (cancel) {
          that._cancelAssess = cancel;
        },
        onDelta: function () {}
      })
      .then(function (full) {
        var g = schema.normAssessGrade(chat.extractJson(full));
        var results = g.results.slice(0, qa.length);
        /* 判分必须覆盖全部题：normAssessGrade 只保证 results 非空（schema.js:277），模型少判是常态。
         * 只按子集判定，3 题判回 1 题且该题 mastered 就会 markChapterMastered（误标「已掌握」）；
         * 下面的 forEach 又按位置配对，少判时题/答还会错位落进 assessments。
         * 判分不完整按失败处理：不落档案、不写 masteredAt，答案保留可重交。 */
        if (results.length !== qa.length) {
          throw new Error("判分只回了 " + results.length + "/" + qa.length + " 题，这次不算——答案还在，再交一次。");
        }
        /* 逐题落 book.assessments 档案（换路线/重排不丢）+ 三题全过补掌握标记。
         * 合并一次写全（addChapterAssessments：单次整本 clone + 单次 markDirty）：
         * 旧实现在循环里逐条 addChapterAssessment、再补 markChapterMastered，
         * 每条都是整本深拷贝（book 可达约 1MB）——一次提交 3-4 次串行 MB 级
         * JSON 往返，低端机可感卡顿（applyQuizPass 注释点名的同型反模式）。 */
        var records = results.map(function (r, i) {
          return {
            chapterId: c.id,
            kind: r.kind,
            question: qa[i].question,
            answer: qa[i].answer,
            level: r.level,
            evidence: r.evidence,
            feedback: r.feedback
          };
        });
        var allMastered = results.every(function (r) { return r.level === "mastered"; });
        var hasWeak = results.some(function (r) { return r.level !== "mastered"; });
        var evidence = allMastered
          ? results
              .map(function (r) { return r.evidence; })
              .filter(Boolean)
              .join(" ")
          : "";
        store.addChapterAssessments(
          that.bookId,
          records,
          hasWeak ? g.misconception : null,
          allMastered ? { chapterId: c.id, evidence: evidence } : null
        );
        that.setData({
          assessBusy: false,
          assessResult: {
            rows: results.map(function (r) {
              var tone = VERDICT_TONE[r.level] || VERDICT_TONE.not;
              return {
                kindLabel: schema.ASSESS_KIND_LABELS[r.kind] || "验收",
                levelLabel: tone.label,
                levelCls: tone.cls,
                feedback: r.feedback,
                evidence: r.evidence
              };
            }),
            suggestion: g.suggestion || "",
            allMastered: allMastered
          }
        });
        that.render();
      })
      .catch(function (e) {
        that.setData({ assessBusy: false });
        util.toast(e.message || "判定失败——答案还在，可重交。");
      });
  },

  /* ---------------- 节点状态（手动标记不写 masteredAt） ---------------- */

  markChapterStatus: function (e) {
    var status = e.currentTarget.dataset.status;
    var chapterId = e.currentTarget.dataset.id || (this.data.chapter && this.data.chapter.id);
    if (status !== "reading" && status !== "done" && status !== "skipped") return;
    store.setChapterStatus(this.bookId, chapterId, status);
    this.setData({ showChapters: false });
    this.render();
    if (status === "done") util.toast("已标记读完（通过验收才会记「掌握」）", "success");
  },

  /* ---------------- 整本五态状态机 ---------------- */

  bookAction: function (e) {
    var action = e.currentTarget.dataset.action;
    var that = this;
    if (action === "finish") {
      store.setBookReadStatus(this.bookId, "finished");
      util.toast("已读完。可以整本验收，或继续逐章验收", "success");
    } else if (action === "whole-assess") {
      store.setBookReadStatus(this.bookId, "assessing");
      store.updateBook(this.bookId, { chatMode: "recall-check", modeJustSwitched: true });
      util.toast("复盘检验已就位——合上书，把整本书讲给它听。聊完点「确认已掌握」");
    } else if (action === "confirm-mastered") {
      store.setBookReadStatus(this.bookId, "mastered");
      util.toast("这本书已掌握。沉淀还在，随时回看", "success");
    }
    that.render();
  },

  /* ---------------- 沉淀（七类一句话 + 节点小结） ---------------- */

  toggleDeposits: function () {
    this.setData({ showDeposits: !this.data.showDeposits });
  },

  pickDepositType: function (e) {
    this.setData({ depositType: e.currentTarget.dataset.id });
  },

  onDepositInput: function (e) {
    this.setData({ depositText: e.detail.value });
  },

  saveDeposit: function () {
    var text = this.data.depositText.trim();
    if (!text) {
      util.toast("写一句话再存");
      return;
    }
    var type = this.data.depositType;
    var chapterId = this.data.chapter ? this.data.chapter.id : undefined;
    store.addBookDeposit(this.bookId, { type: type, text: text, chapterId: chapterId });
    this.setData({ depositText: "" });
    util.toast("已沉淀。你自己的话，比 AI 的总结值钱。", "success");
    this.render();
  },

  /* 节点小结（task=reading-recap，流式）→ 可存入第二大脑 */
  nodeRecap: function () {
    var that = this;
    var b = store.bookById(this.bookId);
    var chapter = this.data.chapter;
    if (!b || !chapter || that.data.recapBusy) return;
    that.setData({ recapBusy: true, recap: null });
    var deposits = (b.deposits || []).filter(function (d) { return d.chapterId === chapter.id; });
    var chatText = (b.chat || [])
      .map(function (m) { return (m.role === "user" ? "用户" : "伙伴") + "：" + m.content; })
      .join("\n")
      .slice(0, 3000);
    var buf = "";
    var renderer = streamView.createStreamRenderer(function () {
      that.setData({ recap: { chapterId: chapter.id, title: chapter.title, blocks: md.parse(buf).blocks } });
    }, 180);
    chat
      .streamChat({
        task: "reading-recap",
        args: {
          book: b.title,
          chapter: schema.chapterJson(store.findChapter(b, chapter.id)),
          deposits: JSON.stringify(deposits.map(function (d) { return { type: d.type, text: d.text }; })),
          chatExcerpt: chatText
        },
        messages: [{ role: "user", content: "生成小结。" }],
        temperature: 0.3,
        register: function (cancel) {
          that._cancelRecap = cancel;
        },
        onDelta: function (d) {
          buf += d;
          renderer.push();
        }
      })
      .then(function (full) {
        renderer.flush();
        var text = full || buf;
        if (!text.trim()) throw new Error("小结内容为空");
        that.setData({ recapBusy: false, recap: { chapterId: chapter.id, title: chapter.title, blocks: md.parse(text).blocks, _md: text } });
      })
      .catch(function (e) {
        renderer.cancel();
        that.setData({ recapBusy: false, recap: null });
        util.toast(e.message || "小结失败");
      });
  },

  saveRecap: function () {
    var that = this;
    var recap = this.data.recap;
    var b = store.bookById(this.bookId);
    if (!recap || !recap._md || !b || that.data.recapSaving) return;
    that.setData({ recapSaving: true });
    store.addReadKnowledge(
      [{ title: "《" + b.title + "》· " + recap.title, body: recap._md, domain: b.title }],
      "《" + b.title + "》"
    );
    that.setData({ recapSaving: false, recap: null });
    util.toast("小结已入第二大脑。", "success");
  },

  closeRecap: function () {
    if (this.data.recapBusy) return;
    if (this._cancelRecap) this._cancelRecap();
    this.setData({ recap: null });
  },

  /* ---------------- 五模式对话（原有） ---------------- */

  bookCtx: function () {
    var b = store.bookById(this.bookId);
    /* 他端删书后本端 pullIfSafe→adoptCloud 会整体替换 books：这里不加守卫会同步抛
     * TypeError，而调用方已置 busy=true → composer 永久卡死、输入丢失。 */
    if (!b) return "{}";
    var chapter = this.data.chapter;
    var c = chapter ? store.findChapter(b, chapter.id) : null;
    /* 阅读系统 V1.0 上下文：地图/目标/本章弱点/沉淀（与 Web readCtx 同语义） */
    var weak = (b.assessments || [])
      .filter(function (a) { return c && a.chapterId === c.id && a.level !== "mastered"; })
      .slice(-2)
      .map(function (a) { return schema.ASSESS_KIND_LABELS[a.kind] + "：" + a.feedback; });
    var ctx = {
      title: b.title,
      author: b.author,
      planSummary: b.planSummary,
      map: b.map
        ? {
            coreProblem: b.map.coreProblem,
            authorStance: b.map.authorStance,
            lineage: b.map.lineage,
            controversies: b.map.controversies
          }
        : undefined,
      readingGoal: schema.goalText(b.goal),
      currentChapter: c
        ? {
            title: c.title,
            focusQuestion: c.focusQuestion,
            knowledgeType: c.knowledgeType || "concept",
            coreIdea: c.coreIdea || "",
            keyConcepts: c.keyConcepts || []
          }
        : null,
      chapterWeakPoints: weak,
      pastedExcerpt: (b.pastedText || "").slice(0, 2000),
      deposits: (b.deposits || [])
        .filter(function (d) { return !c || d.chapterId === c.id; })
        .slice(0, 8)
        .map(function (d) { return d.text; }),
      insights: (b.insights || []).map(function (i) { return i.text; })
    };
    return JSON.stringify(ctx, null, 1);
  },

  send: function () {
    var that = this;
    var text = that.data.input.trim();
    if (!text || that.data.busy) return;
    /* 书被删后 render 会把 book/mode 置空（book.wxml 已切到空态），但 setData 与事件
     * 排队之间存在毫秒级窗口，此间的 tap 仍会进来。裸读会在 busy 置真之后抛 TypeError，
     * 复位语句永远执行不到 → composer 永久锁死（council.sendSingle 的同型守卫）。 */
    var book = that.data.book;
    var mode = that.data.mode;
    if (!book || !mode) {
      util.toast("这本书已经不在了");
      return;
    }
    that.setData({ input: "", busy: true, streamBlocks: [] });
    var modeSwitch = book.modeJustSwitched === true;
    var sendOpts = {
      args: { bookCtx: that.bookCtx(), ragCtx: "", mode: mode.id, modeSwitch: modeSwitch },
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
    /* 带最近几轮历史：旧实现只发当前一条，多轮追问彻底失忆（day/council/Web 端都带） */
    var bNow = store.bookById(that.bookId);
    var history = ((bNow && bNow.chat) || [])
      .slice(-6)
      .map(function (m) { return { role: m.role, content: m.content }; });
    if (!history.length) history = [{ role: "user", content: text }];
    var stream = "";
    var renderer = streamView.createStreamRenderer(function () {
      that.setData({ streamBlocks: md.parse(stream).blocks });
    }, 180);
    chat
      .streamChat({
        task: sendOpts.task,
        args: sendOpts.args,
        messages: history,
        register: function (cancel) {
          that._cancelStream = cancel;
        },
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
        /* 失败也要落持久标记（用户消息已入库）：有半截增量就保留，别整体抹掉 */
        var partial = (e && e.partial) || stream;
        if (partial) {
          store.addBookMsg(that.bookId, {
            id: util.uid("m"),
            role: "assistant",
            content: "（生成中断，以下是已生成的部分）\n\n" + partial,
            failed: true,
            at: new Date().toISOString()
          });
          that.setData({
            chatView: that.data.chatView.concat([
              { role: "assistant", blocks: md.parse(partial).blocks }
            ])
          });
        } else {
          store.addBookMsg(that.bookId, {
            id: util.uid("m"),
            role: "assistant",
            content: "（本次回答生成失败" + (e && e.message ? "：" + e.message : "") + "。请重新发送。）",
            failed: true,
            at: new Date().toISOString()
          });
        }
        util.toast((e && e.message) || "发送失败");
        that.setData({ streamBlocks: [] });
        that.scrollBottom();
      })
      .then(function () {
        that.setData({ busy: false });
      });
  },

  copyCode: function (e) {
    util.copyText(e.currentTarget.dataset.code || "", "代码已复制");
  }
});
