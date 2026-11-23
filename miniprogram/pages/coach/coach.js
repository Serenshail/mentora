var store = require("../../utils/store.js");
var chat = require("../../utils/chat.js");
var schema = require("../../utils/schema.js");
var md = require("../../utils/md.js");
var util = require("../../utils/util.js");
var streamView = require("../../utils/stream-view.js");
/* 消息视图映射统一走 utils/chat-view.js：本页此前又留了一份本地 toView，
 * 是该映射「4 个文件 8+ 处复制」没收干净的最后一份。 */
var chatView = require("../../utils/chat-view.js");

/* 学习教练引导页：苏格拉底轻引导 → 目标卡 → 总纲要。
 * 与 Web /learn/new 同链路（task=intake / plan mode=master），
 * 轻引导纪律在服务端提示词里（最多追问 2 轮），UI 提供「直接生成」出口。 */

Page({
  data: {
    stage: "chat", // chat | planning | done
    messages: [], // 视图：{role, content | blocks}
    input: "",
    busy: false,
    streamBlocks: [],
    card: null, // 目标卡视图
    cardView: null,
    toBottom: "",
    userName: ""
  },

  onLoad: function () {
    /* 引导对话存在页面实例（this.messages），不是 data 的镜像——微信框架不会把
     * data 镜像到实例上。旧实现从未初始化它，onLoad 首句 appendAssistant 就
     * undefined.concat 抛 TypeError：send/confirmCard（intakeTranscript）同样依赖，
     * 引导→目标卡→总纲要整条链路直接崩溃。 */
    this.messages = [];
    /* 流式回调的卸载纪律（review.js 同款）：离开页面后不再对已销毁页面
     * setData、不再把「生成已停止」等 toast 弹到用户刚到达的新页面。 */
    this._unloaded = false;
    var user = getApp().globalData.user;
    this.userName = (user && user.name) || "";
    /* 首问开场：像教练开口，不摆问卷 */
    this.appendAssistant("想弄明白什么？一句话说说要学的东西，我先把方向和目标定下来。");
  },

  onUnload: function () {
    this._unloaded = true;
    if (this._cancel) this._cancel();
    /* 成功跳转的 600ms 定时器不随页面销毁取消的话，用户在这窗口内按返回
     * 会被 wx.redirectTo（App 级 API）从到达的页面强拉回 goal 页。 */
    if (this._redirectTimer) {
      clearTimeout(this._redirectTimer);
      this._redirectTimer = null;
    }
  },

  appendAssistant: function (text) {
    this.messages = this.messages.concat([{ role: "assistant", content: text }]);
    if (this._unloaded) return; // 已离开页面：不再对销毁的页面实例 setData
    this.setData({
      messages: chatView.toChatView(this.messages),
      toBottom: "coach-bottom"
    });
  },

  onInput: function (e) {
    this.setData({ input: e.detail.value });
  },

  scrollBottom: function () {
    var that = this;
    wx.nextTick(function () {
      that.setData({ toBottom: "coach-bottom" });
    });
  },

  send: function () {
    var that = this;
    var text = that.data.input.trim();
    if (!text || that.data.busy || that.data.card) return;
    that.setData({ input: "", busy: true, streamBlocks: [] });
    that.messages = that.messages.concat([{ role: "user", content: text }]);
    var firstTopic = that._topic || text.slice(0, 40);
    that._topic = firstTopic;
    that.setData({
      messages: chatView.toChatView(that.messages),
      toBottom: "coach-bottom"
    });
    var history = that.messages
      .slice(0, -1)
      .slice(-8)
      .map(function (m) {
        return { role: m.role, content: m.content };
      });
    var buf = "";
    var renderer = streamView.createStreamRenderer(function () {
      that.setData({ streamBlocks: md.parse(buf).blocks });
    }, 180);
    chat
      .streamChat({
        task: "intake",
        args: { topic: firstTopic, userName: that.userName },
        messages: history.concat([{ role: "user", content: text }]),
        register: function (cancel) {
          that._cancel = cancel;
        },
        onDelta: function (d) {
          buf += d;
          renderer.push();
        }
      })
      .then(function (full) {
        that._cancel = null;
        if (that._unloaded) {
          renderer.cancel();
          return;
        }
        renderer.flush();
        var content = full || buf;
        /* 每轮回复后尝试解析目标卡：出卡就停在确认态（继续聊的输入会被挡住） */
        var r = schema.splitGoalReply(content);
        if (r.card) {
          that._cardRaw = r.card;
          that.appendAssistant(r.prose || "目标已经清楚了。");
          that.setData({ card: r.card, cardView: that.cardToView(r.card) });
        } else {
          that.appendAssistant(content);
        }
      })
      .catch(function (e) {
        that._cancel = null;
        renderer.cancel();
        /* 取消/失败发生在离开页面之后：不打扰用户已到达的界面
         * （review.js:122 的同一条纪律——toast 不弹在已离开的界面里） */
        if (that._unloaded) return;
        var partial = (e && e.partial) || buf;
        if (partial.trim().length > 60) {
          that.appendAssistant("（生成中断，以下是已生成的部分）\n\n" + partial);
        } else {
          that.appendAssistant(
            "（刚才没连上" + (e && e.message ? "：" + e.message : "") + "。请重发一次。）"
          );
        }
        util.toast((e && e.message) || "生成失败");
      })
      .then(function () {
        if (that._unloaded) return;
        that.setData({ busy: false, streamBlocks: [] });
        that.scrollBottom();
      });
  },

  cardToView: function (card) {
    return {
      topic: card.topic,
      direction: card.direction,
      weeklyHours: card.weeklyHours,
      criteria: card.successCriteria,
      assumptions: card.assumptions || [],
      profile: card.learnerProfile || []
    };
  },

  /* 「继续聊」：把卡收回，允许用户补充/修改（轻引导不锁死） */
  dismissCard: function () {
    this.setData({ card: null, cardView: null });
  },

  /* 确认目标卡 → 建目标 → 生成总纲要（task=plan mode=master，与 Web confirmCard 同链路）。
   * 生成失败重试时不重复建目标：goal 只建一次（this._goalId）。 */
  confirmCard: function () {
    var that = this;
    var card = that._cardRaw;
    if (!card || that.data.busy) return;
    var goal;
    if (that._goalId) {
      goal = store.goalById(that._goalId);
    }
    if (!goal) {
      goal = {
        id: util.uid("g"),
        topic: card.topic,
        direction: card.direction,
        domainKind: card.domainKind,
        motivation: card.motivation,
        background: card.background,
        weeklyHours: card.weeklyHours,
        learnerProfile: card.learnerProfile || [],
        successCriteria: card.successCriteria,
        assumptions: card.assumptions || [],
        status: "active",
        createdAt: new Date().toISOString(),
        quizLog: [],
        /* 引导对话快照必须设上限：goal 随 serialize() 进云端全量快照与
         * setStorageSync 单 key 缓存，服务端 4.2MB 硬拒、单 key 1MB 上限——
         * 无界数组会把推/拉与本地缓存一起拖死（quizLog/消息数组已因同一
         * 机制修过，见 store.js QUIZ_LOG_MAX / MSG_MAX 注释）。留最近 40 轮、
         * 单条截 4000 字，超出部分对回看无用。 */
        intakeTranscript: util.capMessages(
          that.messages.map(function (m) {
            return { role: m.role, content: m.content };
          }),
          40,
          4000
        )
      };
      store.addGoal(goal);
      that._goalId = goal.id;
    }
    that.setData({ stage: "planning", busy: true, card: null, cardView: null });
    chat
      .streamChat({
        task: "plan",
        args: { mode: "master", cardJson: JSON.stringify(card, null, 2) },
        messages: [{ role: "user", content: "目标卡已确认，请生成总学习纲要（只要 JSON）。" }],
        temperature: 0.5,
        register: function (cancel) {
          that._cancel = cancel;
        },
        onDelta: function () {}
      })
      .then(function (full) {
        that._cancel = null;
        /* 计划是已计费的产出：即使用户已离开也照常落库（目标列表可见），
         * 但不再对已销毁页面 setData / toast / 跳转。 */
        var plan = schema.masterDraftToPlan(chat.extractJson(full), card);
        store.updateGoal(goal.id, { plan: plan });
        /* 总纲要入第二大脑：标题公式与 Web 一字不差（阶段双链占位，Web 生成阶段笔记后自动接通） */
        var outlineMd = plan.phases
          .map(function (p) {
            return "- **[[" + goal.topic + " 学习计划 · " + p.title + "]]**\n  " + (p.outcome || "");
          })
          .join("\n");
        store.addKnowledgeItems(
          [
            {
              title: goal.topic + " 学习计划 · 学习总纲要",
              body: "**方向：**" + goal.direction + "\n\n" + plan.summary + "\n\n" + outlineMd,
              domain: goal.topic + "/计划"
            }
          ],
          "learn",
          goal.topic + " · 总纲要"
        );
        if (that._unloaded) return;
        that.setData({ stage: "done", busy: false });
        util.toast("计划已生成，开始第一天", "success");
        /* 600ms 后跳 goal：定时器登记到实例，onUnload 取消——否则用户在这
         * 个窗口内按返回离开，redirectTo 会把人从到达的页面强拉回 goal 页。 */
        that._redirectTimer = setTimeout(function () {
          that._redirectTimer = null;
          if (that._unloaded) return;
          wx.redirectTo({ url: "/pages/goal/goal?goalId=" + goal.id });
        }, 600);
      })
      .catch(function (e) {
        that._cancel = null;
        /* 失败发生在离开页面之后：「可再试一次」的提示只对还在本页的人有意义，
         * toast 不能弹在用户刚到达的别的界面上（review.js 同一条纪律）。 */
        if (that._unloaded) return;
        /* 总纲要失败：目标已保存（列表明里可见），可回本页对同一目标重试——
         * 简化处理：留在本页给「再试一次」，用已确认字段重发 master。 */
        that.setData({ busy: false, stage: "chat" });
        that._cardRaw = card;
        that.setData({ card: card, cardView: that.cardToView(card) });
        util.toast((e && e.message) || "总纲要生成失败，目标已保存，可再试一次");
      });
  }
});
