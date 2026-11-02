var store = require("../../utils/store.js");
var chat = require("../../utils/chat.js");
var seats = require("../../utils/seats.js");
var md = require("../../utils/md.js");
var util = require("../../utils/util.js");
var streamView = require("../../utils/stream-view.js");

var DEFAULT_SEATS = ["naval", "jobs", "taleb"];

// 有真人头像的席位（与网页版 public/personas 一致）
var PHOTO_IDS = ["naval", "jobs", "munger", "feynman", "taleb", "graham", "karpathy", "musk", "zhangxuefeng", "zhangyiming", "mrbeast", "sutskever"];

/* 认知工具席（不是人，是思维模型）。必须在使用前定义——
 * 此前它写在文件末尾，openPick 运行时读到的是 undefined，
 * 于是"人物/工具"两类席位在 UI 上无法正确分组。 */
var CONCEPT_IDS = {
  "first-principles": true,
  incentives: true,
  "antifragile-filter": true,
  "attention-econ": true
};

/** 取名字首字（中文取第一个字，英文取首字母大写） */
function initialOf(name) {
  if (!name) return "?";
  var c = String(name).trim().charAt(0);
  return /[a-z]/i.test(c) ? c.toUpperCase() : c;
}

function resolvePersona(id) {
  if (!id || id === "roundtable") return null;
  var s = seats.byId(id);
  if (s) return { id: s.id, name: s.name, tag: s.tag, custom: false, system: "" };
  var c = store.state.customPersonas.filter(function (x) {
    return x.id === id;
  })[0];
  if (c) return { id: c.id, name: c.name, tag: c.tag, custom: true, system: c.system };
  return null;
}

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
    view: "list", // list | pick | chat
    sessions: [],
    // 选择器
    pickMode: "single", // single | roundtable
    allSeats: [],
    picked: {},
    pickedCount: 0,
    // 会话
    session: null, // {id, personaId, title, isRoundtable, personaName, personaTag}
    chatView: [],
    input: "",
    busy: false,
    streamBlocks: [],
    // 圆桌运行态
    rtSeats: [], // [{id,name,color,status}]  status: pending|streaming|done|failed
    rtPhase: "", // takes | host
    rtHostBlocks: [],
    navH: "" // 由 nav-bar 组件量出后回写，用于算对话区高度
  },

  onShow: function () {
    if (!store.state.userId && !getApp().globalData.user) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    // tab 页每次回来都要刷新列表；但正在对话中的会话不要被打断
    if (this.data.view === "list") this.renderList();
  },

  renderList: function () {
    var sessions = store.state.sessions.map(function (s) {
      var p = resolvePersona(s.personaId);
      var title = s.title || (s.personaId === "roundtable" ? "圆桌会议" : p ? p.name : "会话");
      return {
        id: s.id,
        title: title,
        initial: initialOf(title),
        count: (s.messages || []).length,
        when: (s.createdAt || "").slice(5, 10).replace("-", "/"),
        roundtable: s.personaId === "roundtable"
      };
    });
    this.setData({ view: "list", sessions: sessions });
  },

  /* ---------------- 新建选择器 ---------------- */

  openPick: function () {
    var picked = {};
    DEFAULT_SEATS.forEach(function (id) {
      picked[id] = true;
    });
    var allSeats = seats.ALL.map(function (s) {
      return {
        id: s.id,
        name: s.name,
        tag: s.tag,
        color: s.color,
        initial: initialOf(s.name),
        concept: CONCEPT_IDS[s.id] === true,
        hasPhoto: PHOTO_IDS.indexOf(s.id) >= 0
      };
    });
    this.setData({
      view: "pick",
      pickMode: "single",
      picked: {},
      pickedCount: 0,
      allSeats: allSeats
    });
  },

  switchPickMode: function (e) {
    var mode = e.currentTarget.dataset.mode;
    var picked = {};
    if (mode === "roundtable") {
      DEFAULT_SEATS.forEach(function (id) {
        picked[id] = true;
      });
    }
    this.setData({
      pickMode: mode,
      picked: picked,
      pickedCount: Object.keys(picked).length
    });
  },

  toggleSeat: function (e) {
    var id = e.currentTarget.dataset.id;
    var picked = Object.assign({}, this.data.picked);
    if (this.data.pickMode === "single") {
      // 单聊：点击席位直接开始
      this.startWith(id);
      return;
    }
    if (picked[id]) delete picked[id];
    else picked[id] = true;
    this.setData({ picked: picked, pickedCount: Object.keys(picked).length });
  },

  startRoundtable: function () {
    var ids = Object.keys(this.data.picked);
    if (ids.length < 2) {
      util.toast("圆桌至少选 2 席");
      return;
    }
    var sess = {
      id: util.uid("s"),
      personaId: "roundtable",
      participants: ids,
      title: "圆桌(" + ids.length + "人)",
      messages: [],
      createdAt: new Date().toISOString()
    };
    store.addSession(sess);
    this.openSession(sess.id);
  },

  /* ---------------- 会话 ---------------- */

  openSession: function (id) {
    this.sessionId = id;
    var s = store.sessionById(id);
    if (!s) return;
    var p = resolvePersona(s.personaId);
    this.setData({
      view: "chat",
      session: {
        id: s.id,
        personaId: s.personaId,
        title: s.title,
        isRoundtable: s.personaId === "roundtable",
        personaName: p ? p.name : "圆桌",
        personaTag: p ? p.tag : ""
      },
      chatView: toChatView(s.messages || []),
      input: "",
      busy: false,
      streamBlocks: [],
      rtSeats: [],
      rtPhase: "",
      rtHostBlocks: []
    });
  },

  back: function () {
    if (this.data.view === "chat") this.renderList();
    else this.setData({ view: "list" });
  },

  deleteSession: function (e) {
    var that = this;
    var id = e.currentTarget.dataset.id;
    wx.showModal({
      title: "删除这场会话？",
      content: "删除后不可恢复。",
      success: function (res) {
        if (res.confirm) {
          store.removeSession(id);
          that.renderList();
        }
      }
    });
  },

  onInput: function (e) {
    this.setData({ input: e.detail.value });
  },

  /* ---------------- 单聊 ---------------- */

  startWith: function (personaId) {
    var p = resolvePersona(personaId);
    if (!p) return;
    var sess = {
      id: util.uid("s"),
      personaId: personaId,
      title: p.name,
      messages: [],
      createdAt: new Date().toISOString()
    };
    store.addSession(sess);
    this.openSession(sess.id);
  },

  sendSingle: function (text) {
    var that = this;
    var s = store.sessionById(that.sessionId);
    var personaId = s.personaId;
    var p = resolvePersona(personaId);
    var custom = p && p.custom ? p.system : undefined;
    store.addSessionMsg(that.sessionId, {
      id: util.uid("m"),
      role: "user",
      content: text,
      at: new Date().toISOString()
    });
    that.setData({
      chatView: that.data.chatView.concat([{ role: "user", content: text }])
    });
    // s.messages 已包含刚落地的用户消息（store 里是同一引用），直接截尾即可
    var history = (s.messages || []).slice(-8);
    var stream = "";
    var renderer = streamView.createStreamRenderer(function () {
      that.setData({ streamBlocks: md.parse(stream).blocks });
    }, 180);
    chat
      .streamChat({
        task: "council",
        args: { mode: "single", personaId: personaId, customSystem: custom },
        messages: history.map(function (m) {
          return { role: m.role, content: m.content };
        }),
        temperature: 0.8,
        onDelta: function (d) {
          stream += d;
          renderer.push();
        }
      })
      .then(function (full) {
        renderer.flush();
        var content = full || stream;
        store.addSessionMsg(that.sessionId, {
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
      })
      .catch(function (e) {
        renderer.cancel();
        util.toast(e.message || "发言失败");
        that.setData({ streamBlocks: [] });
      })
      .then(function () {
        that.setData({ busy: false });
      });
  },

  /* ---------------- 圆桌 ---------------- */

  sendRoundtable: function (text, retry) {
    var that = this;
    var s = store.sessionById(that.sessionId);
    if (!s) return;
    var question = retry ? retry.question : text;
    var participants = (s.participants || [])
      .map(resolvePersona)
      .filter(Boolean);
    var goodTakes = (retry && retry.goodTakes) || {};

    if (!retry) {
      store.addSessionMsg(that.sessionId, {
        id: util.uid("m"),
        role: "user",
        content: question,
        at: new Date().toISOString()
      });
      if ((s.messages || []).length === 0) {
        var d = new Date();
        store.updateSession(that.sessionId, {
          title:
            question.replace(/\s+/g, " ").slice(0, 16) +
            " · " +
            participants.length +
            "人 · " +
            (d.getMonth() + 1) +
            "/" +
            d.getDate()
        });
      }
      that.setData({
        chatView: that.data.chatView.concat([{ role: "user", content: question }])
      });
    }

    var seatState = participants.map(function (p) {
      return {
        id: p.id,
        name: p.name,
        color: (seats.byId(p.id) || {}).color || "#86868b",
        hasPhoto: PHOTO_IDS.indexOf(p.id) >= 0,
        status: goodTakes[p.id] ? "done" : "pending",
        take: goodTakes[p.id] || ""
      };
    });
    that.setData({ rtSeats: seatState, rtPhase: "takes", rtHostBlocks: [] });

    var takes = Object.assign({}, goodTakes);
    var runSequential = function (i) {
      if (i >= seatState.length) return Promise.resolve();
      var seat = seatState[i];
      if (seat.status === "done") return runSequential(i + 1);
      seat.status = "streaming";
      /* 性能：只把这一席的状态用路径更新传给渲染层（官方 setData 纪律：
       * 只传变化的数据路径）。此前每个 delta 都整组 rtSeats 全量传输。 */
      that.setData({
        ["rtSeats[" + i + "].status"]: "streaming",
        ["rtSeats[" + i + "].take"]: ""
      });
      var seatIndex = i;
      var p = resolvePersona(seat.id);
      var stream = "";
      var renderer = streamView.createStreamRenderer(function () {
        that.setData({ ["rtSeats[" + seatIndex + "].take"]: stream });
      }, 180);
      return chat
        .streamChat({
          task: "council",
          args: {
            mode: "take",
            name: p.name,
            personaId: p.id,
            customSystem: p.custom ? p.system : undefined
          },
          messages: [{ role: "user", content: question }],
          temperature: 0.8,
          onDelta: function (d) {
            stream += d;
            seat.take = stream;
            renderer.push();
          }
        })
        .then(function (full) {
          renderer.flush();
          seat.take = full || stream;
          seat.status = seat.take ? "done" : "failed";
          if (seat.take) takes[seat.id] = seat.take;
          that.setData({
            ["rtSeats[" + seatIndex + "].status"]: seat.status,
            ["rtSeats[" + seatIndex + "].take"]: seat.take
          });
        })
        .catch(function () {
          renderer.cancel();
          seat.status = "failed";
          that.setData({ ["rtSeats[" + seatIndex + "].status"]: "failed" });
        })
        .then(function () {
          return runSequential(i + 1);
        });
    };

    runSequential(0).then(function () {
      var validIds = Object.keys(takes).filter(function (id) {
        return takes[id];
      });
      var nameOf = function (id) {
        var p = resolvePersona(id);
        return p ? p.name : "与会者";
      };
      if (validIds.length < 2) {
        store.addSessionMsg(that.sessionId, {
          id: util.uid("m"),
          role: "assistant",
          content:
            "> 本轮有效发言不足 2 席，主持人不强行综合。请重试本轮。",
          at: new Date().toISOString()
        });
        that.setData({
          chatView: toChatView(store.sessionById(that.sessionId).messages || []),
          rtPhase: "",
          busy: false
        });
        return;
      }
      that.setData({ rtPhase: "host" });
      var names = validIds
        .map(nameOf)
        .join("、");
      var takesText = validIds
        .map(function (id) {
          return "【" + nameOf(id) + "】" + takes[id];
        })
        .join("\n\n");
      var hostStream = "";
      var hostRenderer = streamView.createStreamRenderer(function () {
        that.setData({ rtHostBlocks: md.parse(hostStream).blocks });
      }, 180);
      chat
        .streamChat({
          task: "council",
          args: { mode: "host", names: names, takes: takesText, question: question },
          messages: [{ role: "user", content: "请写圆桌纪要。" }],
          temperature: 0.4,
          onDelta: function (d) {
            hostStream += d;
            hostRenderer.push();
          }
        })
        .then(function (full) {
          hostRenderer.flush();
          var content = "## 圆桌纪要\n\n" + (full || hostStream);
          store.addSessionMsg(that.sessionId, {
            id: util.uid("m"),
            role: "assistant",
            content: content,
            at: new Date().toISOString()
          });
          that.setData({
            chatView: toChatView(store.sessionById(that.sessionId).messages || []),
            rtPhase: "",
            rtSeats: [],
            rtHostBlocks: [],
            busy: false
          });
        })
        .catch(function () {
          hostRenderer.cancel();
          store.addSessionMsg(that.sessionId, {
            id: util.uid("m"),
            role: "assistant",
            content: "> 主持人纪要生成失败：各席发言已完整保留，可重新发送问题重试。",
            at: new Date().toISOString()
          });
          that.setData({
            chatView: toChatView(store.sessionById(that.sessionId).messages || []),
            rtPhase: "",
            busy: false
          });
        });
    });
  },

  /* ---------------- 发送入口 ---------------- */

  send: function () {
    var that = this;
    var text = that.data.input.trim();
    if (!text || that.data.busy) return;
    if (!that.data.session) return;
    that.setData({ input: "", busy: true, streamBlocks: [], rtHostBlocks: [] });
    if (that.data.session.isRoundtable) {
      that.sendRoundtable(text, null);
    } else {
      that.sendSingle(text);
    }
  },

  copyCode: function (e) {
    wx.setClipboardData({ data: e.currentTarget.dataset.code || "" });
  }
});
