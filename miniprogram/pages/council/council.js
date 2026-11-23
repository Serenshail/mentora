var store = require("../../utils/store.js");
var sessionGuard = require("../../utils/session.js");
var chat = require("../../utils/chat.js");
var seats = require("../../utils/seats.js");
var md = require("../../utils/md.js");
var util = require("../../utils/util.js");
var streamView = require("../../utils/stream-view.js");
/* assistant→blocks 的视图映射与 day/book 共用一份实现（utils/chat-view.js） */
var toChatView = require("../../utils/chat-view.js").toChatView;

var DEFAULT_SEATS = ["naval", "jobs", "taleb"];

/* 席位色兜底：与 app.wxss 的 --ink-3 同值（JS 读不到 CSS 变量，集中在这里便于对齐） */
var INK_3 = "#86868b";

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

Page({
  data: {
    view: "list", // list | pick | chat
    sessions: [],
    /* 会话恢复中：列表还没从 store 读出来，此时不能渲染「还没有对话」空态
     * （与 brain 的 loading 守卫同义）。 */
    booting: true,
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
    toBottom: "", // chat 滚底锚点（book 页同款 scroll-into-view 机制）
    navH: "" // 由 nav-bar 组件量出后回写，用于算对话区高度
  },

  onShow: function () {
    var that = this;
    /* 冷启动直达时 store.userId 还没恢复，cookie 却可能有效：旧守卫只看
     * userId/globalData.user，探测在途就 reLaunch 登录页，把已登录用户踢走
     * （login 页也不会自动跳回）。统一走 session.ensure：没有 cookie 才回登录页，
     * 有 cookie 先探测，成功后再渲染。 */
    sessionGuard.ensure(function () {
      // tab 页每次回来都要刷新列表；但正在对话中的会话不要被打断
      if (that.data.view === "list") that.renderList();
    });
  },

  /* app.js 的会话恢复链路（app.js refreshCurrentPage）只认 render()：
   * 本页此前没有，冷启动/重试成功后列表要等切 tab 才刷新。只在列表态补刷，
   * 对话中不打断（与 onShow 的守卫一致）。 */
  render: function () {
    if (this.data.view === "list" && !this.data.busy) this.renderList();
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
    this.setData({ view: "list", sessions: sessions, booting: false });
  },

  /* ---------------- 新建选择器 ---------------- */

  openPick: function () {
    /* 死预填已删：这里塞 DEFAULT_SEATS 后马上被 picked:{} 覆盖，从未生效；
     * 圆桌模式的默认勾选由 switchPickMode 负责。 */
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

  /* 会话/选择器视图 → 列表视图。绑定在两个内部视图的 nav-bar 上
   * （council.wxml：pick 视图直接绑 back，chat 视图经 onNavBack 先中止再调这里）。
   * 旧实现这个函数存在但从未被绑定——tab 页栈长恒为 1，nav-bar 的兜底
   * switchTab 把用户甩去「今天」tab，会话列表在本次运行内不可达。 */
  back: function () {
    if (this.data.view === "chat") this.renderList();
    else this.setData({ view: "list" });
  },

  /* deleteSession 已删（死代码）：全项目没有任何元素绑定它（grep bindtap/catchtap
   * 证实），「删除这场会话？」弹窗永远不可达，会话只能增不能删。留着一个带确认
   * 弹窗的幽灵处理函数只会让后续改动者无从判断它是否在服役；真正要提供删除入口
   * 时应连同列表项的入口一起设计，而不是留着这段孤悬代码。 */

  onInput: function (e) {
    this.setData({ input: e.detail.value });
  },

  /* 自动滚底（book 页同款机制）：发出的问题与流式增长的回答都发生在视口外时，
   * 用户要手动上滑才能看到开头。scroll-into-view 只在值变化时才触发滚动：
   * 先置空再赋值，保证每次都是一次有效变化（book.scrollBottom 同注释）。
   * 滚底是体验增强不是关键路径：wx.nextTick 不可用（极老基础库）时静默跳过。 */
  scrollBottom: function () {
    var that = this;
    if (typeof wx.nextTick !== "function") return;
    wx.nextTick(function () {
      that.setData({ toBottom: "" });
      wx.nextTick(function () {
        that.setData({ toBottom: "chat-bottom" });
      });
    });
  },

  /* 页面内停止入口：长流式（单聊回答、圆桌整链）此前只能离开页面才能中止——
   * 这些是真实计费的 BYOK 调用，点错问题后用户既不能中断也省不了这笔消耗。
   * 与 onNavBack 同一收口：单聊取消在途请求；圆桌还要立中止标志，否则链会
   * 自动续跑后续席位与主持人。取消后各链的 catch 保留半截内容并复位 busy。 */
  stopChat: function () {
    if (!this.data.busy) return;
    if (this._cancelSingle) this._cancelSingle();
    this.abortRoundtable();
  },

  /* 流式中退出：中止在途请求（单聊 / 圆桌各席 / 主持人都可能还在跑）。
   * 圆桌是多席串行，只 cancel 当前一席不够——链会自动续跑后续席位与主持人
   * （每次都是真实计费的 AI 调用），所以必须先立「已中止」标志，链上每步自检。 */
  onUnload: function () {
    if (this._cancelSingle) this._cancelSingle();
    /* 圆桌链的收口与返回箭头共用同一处：立中止标志 + 取消在途席位 + 复位 busy。
     * 只 cancel 当前一席不够（链会自动续跑后续席位与主持人）。 */
    this.abortRoundtable();
  },

  /* nav-bar 的返回箭头在 tab 页里原本走 switchTab（不触发 onUnload），
   * 圆桌会继续跑完全部席位并计费。本页的 chat 视图 nav-bar 以 host-nav 把
   * 导航权交给本页：这里先中止在途调用，再切回列表视图（不会甩去别的 tab）。 */
  onNavBack: function () {
    if (this.data.busy) {
      if (this._cancelSingle) this._cancelSingle();
      this.abortRoundtable();
    }
    this.back();
  },

  /* 中止圆桌整条串行链：立标志（阻止后续席位/主持人再发起）+ 取消在途那一席 */
  abortRoundtable: function () {
    this._rtAborted = true;
    if (this._cancelTake) this._cancelTake();
    if (this._cancelHost) this._cancelHost();
    this.setData({ rtPhase: "", busy: false });
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
    /* 他端删会话后本端会 adoptCloud 换掉 sessions：无守卫会在这里同步抛 TypeError，
     * 而 busy 已经置 true → 输入框永久锁死。 */
    if (!s) {
      that.setData({ busy: false });
      util.toast("这个会话已经不存在了");
      return;
    }
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
    that.scrollBottom();
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
        register: function (cancel) {
          that._cancelSingle = cancel;
        },
        onDelta: function (d) {
          stream += d;
          renderer.push();
        }
      })
      .then(function (full) {
        renderer.flush();
        var content = full || stream;
        /* 空响应当失败：旧实现无条件落一条空 assistant 消息，聊天区出现空白卡片
         * （对照圆桌空 take 标 failed）。throw 进下方 catch 统一走失败分支。 */
        if (!content.trim()) {
          throw new Error("对方没有返回内容，请重试");
        }
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
        that.scrollBottom();
      })
      .catch(function (e) {
        renderer.cancel();
        /* 失败落持久标记：用户消息已入库，只弹瞬时 toast 会让人以为已获回复（与圆桌一致） */
        var partial = (e && e.partial) || stream;
        var content = partial
          ? "（生成中断，以下是已生成的部分）\n\n" + partial
          : "> 本次发言生成失败" + (e && e.message ? "：" + e.message : "") + "。请重新发送重试。";
        store.addSessionMsg(that.sessionId, {
          id: util.uid("m"),
          role: "assistant",
          content: content,
          failed: true,
          at: new Date().toISOString()
        });
        that.setData({
          chatView: that.data.chatView.concat([
            { role: "assistant", blocks: md.parse(content).blocks }
          ]),
          streamBlocks: []
        });
        that.scrollBottom();
        util.toast((e && e.message) || "发言失败");
      })
      .then(function () {
        that.setData({ busy: false });
      });
  },

  /* ---------------- 圆桌 ----------------
   * 拆分纪律（原 sendRoundtable 是 232 行、三层嵌套闭包的单体，文件注释记录的
   * 多个历史 bug——busy 不复位、标题先落库再判空、中止标志漏置——均出自这段）：
   *  · sendRoundtable 只做编排：落库用户消息 → 席位串行（_rtTakeSeat）→ 主持人
   *    （_rtHostPhase），总兜底 catch 收口 busy 复位；
   *  · 各阶段共享的状态（seatState/takes/question）收进一个 st 对象在方法间显式
   *    传递，不再依赖多层闭包；
   *  · 中止检查（_rtAborted）集中在每个阶段入口自检。 */

  /* 圆桌收尾视图：会话还在 → 按库内消息重建视图；会话已被换掉（addSessionMsg
   * 此时是空操作）→ 保留当前视图并补上这条，用户已看到的内容不丢。
   * 圆桌全流程可持续数分钟，期间他端删除该会话后 pullIfSafe → adoptCloud 会
   * 整体换掉 sessions，sessionById 返回 null；三处收尾若裸取
   * sessionById(...).messages，参数在 setData 前求值就会抛 TypeError。 */
  _rtTailView: function (content) {
    var cur = store.sessionById(this.sessionId);
    if (cur) return toChatView(cur.messages || []);
    return this.data.chatView.concat([
      { role: "assistant", blocks: md.parse(content).blocks }
    ]);
  },

  /* 席位串行步进：跑第 i 席并递归后续席位。每步入口自检 _rtAborted
   * （onUnload/返回箭头/停止按钮置位）。 */
  _rtTakeSeat: function (i, st) {
    var that = this;
    /* 已中止（用户返回/离开页面）：后续席位与主持人都不再发起——
     * 每次都是真实计费的 AI 调用，旧实现只 cancel 当前一席，
     * .catch().then(() => runSequential(i+1)) 会一路跑完。 */
    if (that._rtAborted) return Promise.resolve();
    if (i >= st.seatState.length) return Promise.resolve();
    var seat = st.seatState[i];
    /* 自定义席可能在这几分钟里被他端删除（adoptCloud 替换 customPersonas）：
     * 发送时 filter(Boolean) 只保证当时有效，轮到第 2+ 席时 resolvePersona
     * 可能返回 null。裸取 p.name 会在链上抛 TypeError → busy 永不复位。 */
    var p = resolvePersona(seat.id);
    if (!p) {
      seat.status = "failed";
      that.setData({ ["rtSeats[" + i + "].status"]: "failed" });
      return that._rtTakeSeat(i + 1, st);
    }
    seat.status = "streaming";
    /* 性能：只把这一席的状态用路径更新传给渲染层（官方 setData 纪律：
     * 只传变化的数据路径）。此前每个 delta 都整组 rtSeats 全量传输。 */
    that.setData({
      ["rtSeats[" + i + "].status"]: "streaming",
      ["rtSeats[" + i + "].take"]: ""
    });
    var stream = "";
    var renderer = streamView.createStreamRenderer(function () {
      that.setData({ ["rtSeats[" + i + "].take"]: stream });
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
        messages: [{ role: "user", content: st.question }],
        temperature: 0.8,
        register: function (cancel) {
          that._cancelTake = cancel;
        },
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
        if (seat.take) st.takes[seat.id] = seat.take;
        that.setData({
          ["rtSeats[" + i + "].status"]: seat.status,
          ["rtSeats[" + i + "].take"]: seat.take
        });
      })
      .catch(function () {
        renderer.cancel();
        seat.status = "failed";
        that.setData({ ["rtSeats[" + i + "].status"]: "failed" });
      })
      .then(function () {
        return that._rtTakeSeat(i + 1, st);
      });
  },

  /* 主持人阶段：有效席不足的短路分支 + 主持人流式。返回内层 promise 链，
   * 让本分支自身的未预期异常也落进 sendRoundtable 的总兜底 catch（busy 复位
   * 收口），而不是一条无主的 unhandled rejection。 */
  _rtHostPhase: function (st) {
    var that = this;
    /* 已中止：abortRoundtable/onUnload 已复位 busy 并取消了在途请求，
     * 这里不能再补写「有效发言不足」或发起主持人（都是计费调用）。 */
    if (that._rtAborted) return Promise.resolve();
    var takes = st.takes;
    var validIds = Object.keys(takes).filter(function (id) {
      return takes[id];
    });
    var nameOf = function (id) {
      var p = resolvePersona(id);
      return p ? p.name : "与会者";
    };
    if (validIds.length < 2) {
      var shortContent = "> 本轮有效发言不足 2 席，主持人不强行综合。请重试本轮。";
      store.addSessionMsg(that.sessionId, {
        id: util.uid("m"),
        role: "assistant",
        content: shortContent,
        at: new Date().toISOString()
      });
      that.setData({
        chatView: that._rtTailView(shortContent),
        rtPhase: "",
        busy: false
      });
      return Promise.resolve();
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
    return chat
      .streamChat({
        task: "council",
        args: { mode: "host", names: names, takes: takesText, question: st.question },
        messages: [{ role: "user", content: "请写圆桌纪要。" }],
        temperature: 0.4,
        register: function (cancel) {
          that._cancelHost = cancel;
        },
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
          chatView: that._rtTailView(content),
          rtPhase: "",
          rtSeats: [],
          rtHostBlocks: [],
          busy: false
        });
        that.scrollBottom();
      })
      .catch(function () {
        hostRenderer.cancel();
        /* 兑现失败文案的承诺：此刻各席有效发言仍在内存 takes 里，但全程不落库的话，
         * 用户退出会话再进入（openSession 按 s.messages 重建视图、rtSeats 清空）
         * 即永久丢失——文案却声称「已完整保留」。主持人失败分支把发言按席逐条
         * 落库（与会话列表/重进视图同一存储，带席位名前缀，格式同主持人纪要的
         * takesText），承诺才与数据事实相符。成功路径不在此列：库里 user+纪要的
         * 语义由 council-roundtable-session-gone 回归锁钉住（纪要本身就是收口产物）。
         * 会话已被 adoptCloud 换掉时 addSessionMsg 是空操作，不影响视图兜底。 */
        validIds.forEach(function (id) {
          var sp = resolvePersona(id);
          store.addSessionMsg(that.sessionId, {
            id: util.uid("m"),
            role: "assistant",
            content: "【" + (sp ? sp.name : "与会者") + "】" + takes[id],
            seat: id,
            at: new Date().toISOString()
          });
        });
        var failContent =
          "> 主持人纪要生成失败：各席发言已完整保留，可重新发送问题重试。";
        store.addSessionMsg(that.sessionId, {
          id: util.uid("m"),
          role: "assistant",
          content: failContent,
          at: new Date().toISOString()
        });
        that.setData({
          chatView: that._rtTailView(failContent),
          rtPhase: "",
          busy: false
        });
        that.scrollBottom();
      });
  },

  sendRoundtable: function (text) {
    var that = this;
    var s = store.sessionById(that.sessionId);
    /* 早返回必须复位 busy：调用方（onSend）已经置了 busy=true，静默 return 会让
     * composer 永久禁用，用户以为卡死。 */
    if (!s) {
      that.setData({ busy: false });
      util.toast("这个圆桌会话已经不存在了");
      return;
    }
    var question = text;
    var participants = (s.participants || [])
      .map(resolvePersona)
      .filter(Boolean);

    /* 标题要在落首条消息之前判空：旧实现先 addSessionMsg（同一对象引用）再判
     * length === 0，恒 false → 所有圆桌永远叫「圆桌(N人)」，列表无法分辨。 */
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
    store.addSessionMsg(that.sessionId, {
      id: util.uid("m"),
      role: "user",
      content: question,
      at: new Date().toISOString()
    });
    that.setData({
      chatView: that.data.chatView.concat([{ role: "user", content: question }])
    });
    that.scrollBottom();

    var seatState = participants.map(function (p) {
      return {
        id: p.id,
        name: p.name,
        color: (seats.byId(p.id) || {}).color || INK_3,
        hasPhoto: PHOTO_IDS.indexOf(p.id) >= 0,
        status: "pending",
        take: ""
      };
    });
    that.setData({ rtSeats: seatState, rtPhase: "takes", rtHostBlocks: [] });

    /* 本轮开始：清掉上一次的中止标志（onUnload/返回箭头会置它） */
    that._rtAborted = false;
    var st = { seatState: seatState, takes: {}, question: question };
    that
      ._rtTakeSeat(0, st)
      .then(function () {
        return that._rtHostPhase(st);
      })
      .catch(function () {
        /* 兜底：这条链路上任何未预期异常（会话已被云端替换、渲染层异常等）都不能让
         * send() 置的 busy 永远为 true——那等于 composer 永久禁用，用户只能重进页面。
         * 各分支内部已各自复位 busy；这里只兜住"没走到分支"的那部分。 */
        that.setData({ rtPhase: "", busy: false });
        util.toast("圆桌本轮中断，请重试");
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
      that.sendRoundtable(text);
    } else {
      that.sendSingle(text);
    }
  },

  copyCode: function (e) {
    util.copyText(e.currentTarget.dataset.code || "", "代码已复制");
  }
});
