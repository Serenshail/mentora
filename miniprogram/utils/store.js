/* ========= 数据层：与 Web 端 zustand store 同一份数据模型 =========
 * 职责：
 *  1. 登录后从云端拉快照（云端为准；云端空且本机有数据才反推——防"空快照覆盖"事故）
 *  2. 本地改动 → 立即写本机缓存 + 2.5s 防抖推云端；onHide 强制 flush
 *  3. 写路径复刻 Web store 的关键语义：验收过门/迁移题真门/解锁链/MOC 目录/双链解析
 *
 * 与 Web 的已知差异（诚实边界）：
 *  - 复习调度用经典 1/3/7/15/30 档（不引入 FSRS）；fsrs 字段不写，
 *    Web 端会在下次复习时按 reviewStage 预热无缝接管——两边状态互相兼容。
 *  - RAG 检索（教练答疑/读书对话）暂不注入 ragCtx，回答不带第二大脑证据。 */
var api = require("./api.js");
var util = require("./util.js");
var masteryMod = require("./mastery.js");

var INTERVALS = [1, 3, 7, 15, 30];

var state = {
  goals: [],
  knowledge: [],
  books: [],
  sessions: [],
  customPersonas: [],
  folders: [],
  settings: {},
  userId: null
};

var syncStatus = "idle"; // idle | saving | saved | error | conflict
var statusListeners = [];
var pushing = false;
var pendingPush = false;
/* 排队那次推送是哪个会话排下的：换账号后不能把旧会话排的那次当成新账号的
 * 待推送来重放；新账号自己排的（pendingPushEpoch === sessionEpoch）必须照常排空。 */
var pendingPushEpoch = 0;
/* 等推送真正落地的调用方（登出流程要等它，否则清掉 userId 会把在途推送掐死）。
 * 每项带 epoch：旧会话推送的落地不能替新会话的等待者报"已推上云"。 */
var pushWaiters = [];
/* 上次成功见到的云端快照时间（水位）：云端比它旧就不是"更新"，不该覆盖本地 */
var lastCloudAt = "";
/* 会话代数：每次身份切换（换账号登录/登出清状态）自增。云端请求都是跨秒级的
 * （pull 超时上限 60s），响应回来时必须核对发起时的代数——否则前一账号的迟到
 * 快照会被 adoptCloud 写进新账号的 state 与本机缓存，甚至反推上新账号的云端。 */
var sessionEpoch = 0;
/* 编辑代数：每次 markDirty 自增。用来区分"这趟推送带上了全部本地改动"与
 * "在途期间又改了东西、新改动还在防抖窗口里"。没有它时，先发起的推送成功
 * 就会把后一次编辑的脏标记一起清掉，pullIfSafe 的守卫随之出现空洞。 */
var editSeq = 0;

function emitStatus(s) {
  syncStatus = s;
  for (var i = 0; i < statusListeners.length; i++) {
    /* 容错：一个监听器（比如对已销毁页面 setData）抛错不能中断广播 */
    try {
      statusListeners[i](s);
    } catch (e) { /* 忽略单个监听器异常 */ }
  }
}

function onSyncStatus(fn) {
  statusListeners.push(fn);
  fn(syncStatus);
  return function () {
    var i = statusListeners.indexOf(fn);
    if (i >= 0) statusListeners.splice(i, 1);
  };
}

/* ---------------- 本机缓存 ---------------- */

function cacheKey() {
  return state.userId ? "mentora-mp-store-" + state.userId : "mentora-mp-store-anon";
}

/* 脏标记与云端水位都要跨进程持久化：冷启动/切后台回来时，
 * 内存里的 dirtyPending 已经归零，但本地改动其实还没推上去。 */
function dirtyKey() {
  return state.userId ? "mentora-mp-dirty-" + state.userId : "mentora-mp-dirty-anon";
}
function cloudAtKey() {
  return state.userId ? "mentora-mp-cloud-at-" + state.userId : "mentora-mp-cloud-at-anon";
}
/* 本机未推送改动所基于的云端水位（markDirty 由净转脏那一刻记下）。
 * 与脏标记一样必须跨进程持久化：遗留脏标记只有配上它的基准版本，才能判断
 * 期间云端有没有被别的端推过（见 pullIfSafe 的分叉守卫）。 */
function dirtyBaseKey() {
  return state.userId ? "mentora-mp-dirty-base-" + state.userId : "mentora-mp-dirty-base-anon";
}
function readFlag(key) {
  try {
    return wx.getStorageSync(key);
  } catch (e) {
    return "";
  }
}
function writeFlag(key, v) {
  try {
    if (v) wx.setStorageSync(key, v);
    else wx.removeStorageSync(key);
  } catch (e) { /* 配额满：标记丢失好过崩溃；本机缓存仍在 */ }
}

/* 本地快照：写盘走「脏标记 + 防抖」。
 * 为什么：知识库大时（几百篇笔记）JSON.stringify 是 MB 级主线程开销，
 * 而 markDirty 在验收/记笔记/答题等高频路径上每次都会触发——
 * 之前每次都同步写盘，"点一下卡一下"就是它。数据在内存里永远是最新的，
 * 防抖只是推迟持久化；onHide/app onHide 有 flushPush 兜底，不怕丢。 */
var saveTimer = null;
function saveLocalSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    saveLocal();
  }, 800);
}

function saveLocal() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    wx.setStorageSync(
      cacheKey(),
      JSON.stringify({
        goals: state.goals,
        knowledge: state.knowledge,
        books: state.books,
        sessions: state.sessions,
        customPersonas: state.customPersonas,
        folders: state.folders,
        settings: state.settings
      })
    );
  } catch (e) {
    /* 配额满写不进本机：未登录/离线时本机缓存就是唯一副本，必须可见，不能静默丢 */
    emitStatus("error");
  }
}

/* 本机缓存「读不出」与「本来就没有」是两回事：
 *  - 没有缓存（raw 为空）＝首次登录，正常空态；
 *  - 有缓存但读取抛错/JSON.parse 失败（弱网或进程被杀导致的半截写入）＝未推送
 *    数据的唯一副本可能已损坏。旧实现一律静默 return false，于是「云端为空 +
 *    缓存损坏 + 脏标记残留」时页面呈现裸空态，与「从未产生数据」不可区分。
 * 这里记下失败并 emitStatus("error")，让同步徽章可见（四态 UI 里 error 是唯一
 * 可承载「本机数据可能没读出来」的通道）；恢复成功后由 adoptCloud 清掉。 */
var localLoadFailed = false;
/* 本机缓存是否**成功读过**（JSON 解析通过）：区分「真的删光了」（内存态可信，
 * 整包推送把删除同步上云）与「缓存缺失/读不出 → 内存空可能是假的」（绝不
 * 自动整包推空快照盖云端）。pullIfSafe 的脏守卫据此前进。 */
var localLoaded = false;

function loadLocal() {
  var raw = "";
  try {
    raw = wx.getStorageSync(cacheKey());
  } catch (e) {
    localLoadFailed = true;
    localLoaded = false;
    emitStatus("error");
    return false;
  }
  /* 本机无缓存 = 首次登录/换账号后的正常空态，不是失败：必须重置标记。
   * 此前早退不清 localLoadFailed，前一账号的缓存损坏会把新账号的空态误报
   * 成「云端对齐失败」（pullIfSafe 对空账号返回 "error"）。
   * 顺手把徽章也从上一账号可能残留的 error 态拉回中性。 */
  if (!raw) {
    localLoadFailed = false;
    localLoaded = false;
    if (syncStatus === "error") emitStatus("idle");
    return false;
  }
  try {
    var d = JSON.parse(raw);
    state.goals = d.goals || [];
    state.knowledge = d.knowledge || [];
    state.books = d.books || [];
    state.sessions = d.sessions || [];
    state.customPersonas = d.customPersonas || [];
    state.folders = d.folders || [];
    state.settings = d.settings || {};
    localLoadFailed = false;
    localLoaded = true;
    return true;
  } catch (e) {
    localLoadFailed = true;
    localLoaded = false;
    emitStatus("error");
    return false;
  }
}

/* localLoadFailed 由 pullIfSafe 消费：云端为空且本机缓存读不出时返回 "error"
 * 而不是 "none"（后者会被页面渲染成「还没有数据」的空态）。 */

/* ---------------- 云端同步 ---------------- */

function serialize() {
  var s = Object.assign({}, state.settings, { apiKey: "" });
  return {
    goals: state.goals,
    knowledge: state.knowledge,
    books: state.books,
    sessions: state.sessions,
    customPersonas: state.customPersonas,
    folders: state.folders,
    settings: s
  };
}

function cloudHasData(d) {
  if (!d) return false;
  return (
    ((d.goals || []).length +
      (d.knowledge || []).length +
      (d.books || []).length +
      (d.sessions || []).length +
      (d.customPersonas || []).length) > 0
  );
}

function hasLocalData() {
  return (
    state.goals.length +
      state.knowledge.length +
      state.books.length +
      state.sessions.length +
      state.customPersonas.length > 0
  );
}

function adoptCloud(data) {
  state.goals = data.goals || [];
  state.knowledge = data.knowledge || [];
  state.books = data.books || [];
  state.sessions = data.sessions || [];
  state.customPersonas = data.customPersonas || [];
  state.folders = data.folders || [];
  var s = data.settings || {};
  delete s.apiKey;
  state.settings = s;
  /* 云端快照已整体接管：本机缓存此前「读不出」的告警不再成立；
   * 用户已用云端版本收口分叉，下一次分叉提示可以重新弹。
   * 脏标记一并清掉：adoptCloud 只会在「本机无未推送改动」或「用户显式选择从云端
   * 恢复」时被调用，两种情况下本机改动都已被云端版本取代，留着标记只会让下次
   * pullIfSafe 又走一遍守卫、把刚 adopt 的云端版本再推回去。 */
  localLoadFailed = false;
  conflictNotified = false;
  conflictFork = false; /* 用户已用云端版本收口分叉：自动推送恢复常态 */
  dirtyPending = false;
  writeFlag(dirtyKey(), "");
  /* 撤掉挂起的防抖推送：否则它会把刚 adopt 的云端版本再整包推回去（白一次写放大），
   * 或更糟——把 adopt 前的旧编辑残留重新盖到云端。 */
  if (pushDebounced) pushDebounced.cancel();
  /* 在途推送围栏：防抖只挡得住还没发出的推送，挡不住已经在飞的 pushNow——
   * 它起飞时 serialize() 取的是 adopt 前的本地快照 S1。若不 fences，S1 落地时
   * editSeq 仍等于 pushedSeq，成功路径照常推进水位并清脏，云端被 S1 覆盖；
   * 下次拉取时 cloud.updatedAt === lastCloudAt，水位守卫放行 adoptCloud(S1)，
   * 用户的「从云端恢复」被静默撤销。这里自增 editSeq：在途推送落地时发现
   * 代数已前进，走既有的「保留脏标记 + 立即补推」路径，把刚 adopt 的云端版本
   * 重新推上云，云端与本地收敛到恢复版。 */
  editSeq += 1;
  saveLocal();
}

function pushNow() {
  if (!state.userId) return Promise.resolve(false);
  if (pushing) {
    pendingPush = true;
    pendingPushEpoch = sessionEpoch;
    /* 返回一个"等排空"的 promise，而不是立即 false——
     * 登出/切后端要等它真正落地才能清空身份。 */
    var waitEpoch = sessionEpoch;
    return new Promise(function (resolve) {
      pushWaiters.push({ epoch: waitEpoch, resolve: resolve });
    });
  }
  pushing = true;
  /* 发起时的会话代数：推送同样要跨秒级（timeout 60s），期间可能已经登出换账号。
   * 旧账号推送的响应绝不能改写当前账号的水位/脏标记。 */
  var epoch = sessionEpoch;
  /* 这趟推送带上的编辑代数（serialize() 紧随其后同步取 state，二者一一对应）。
   * 上传期间若又有 markDirty，editSeq 会前进，说明新编辑还没上云。 */
  var pushedSeq = editSeq;
  emitStatus("saving");
  return api
    .pushCloud(serialize())
    .then(function (res) {
      pushing = false;
      var sameSession = epoch === sessionEpoch;
      if (sameSession && res && res.updatedAt) {
        lastCloudAt = res.updatedAt;
        writeFlag(cloudAtKey(), lastCloudAt);
      }
      if (pendingPush) {
        var queuedEpoch = pendingPushEpoch;
        pendingPush = false;
        /* 只排空**本会话**排下的后续推送。旧会话排队的那次不能在这里重放：
         * serialize() 读的是当前 state，一旦换账号，就等于拿新账号的本机缓存
         * 去覆盖它自己的云端（新账号登录时该不该推，由 onLogin 的 pullIfSafe
         * 依云端/本机实况决定，不能由旧会话的在途响应越权代劳）。 */
        if (queuedEpoch === sessionEpoch && state.userId) return pushNow();
      }
      if (sameSession) {
        /* 上传的是旧快照（在途期间又编辑，新改动还在 2.5s 防抖窗口里）：
         * 绝不能清脏标记——否则这段窗口里 dirtyPending/pushing/syncStatus
         * 全为假，pullIfSafe 的三重守卫失效，切 tab 的 onShow 会用不含新编辑的
         * 云端快照覆盖本地；进程被杀后下次登录 force-pull 同样丢。
         * 正确收口：保留脏标记、撤掉待触发的防抖，立即补推最新快照；
         * 由内层推送真正落地后再清标记并 settle waiters。 */
        if (editSeq !== pushedSeq) {
          if (pushDebounced) pushDebounced.cancel();
          if (state.userId) return pushNow();
          emitStatus("saving");
          settleWaiters(true, epoch);
          return true;
        }
        dirtyPending = false;
        writeFlag(dirtyKey(), "");
        /* 本机改动已全部上云：基准水位跟着推进到本次推送落地版本 */
        dirtyBaseCloudAt = lastCloudAt;
        writeFlag(dirtyBaseKey(), dirtyBaseCloudAt);
        conflictNotified = false;
        /* 推送真正落地（用户手动「推送到云端」或其他自动路径）：基准与云端
         * 收敛，分叉态解除，自动推送恢复常态。 */
        conflictFork = false;
        emitStatus("saved");
      } else {
        /* 旧会话的落地与当前账号无关：既不能替新账号清脏标记，也不能让界面
         * 停在「同步中…」（新账号可能根本没在同步）。 */
        emitStatus("idle");
      }
      settleWaiters(true, epoch);
      return true;
    })
    .catch(function () {
      pushing = false;
      pendingPush = false;
      /* 旧会话的失败不是新账号的失败，别报假错误 */
      emitStatus(epoch === sessionEpoch ? "error" : "idle");
      /* 推送失败时保留脏标记：下次登录/回前台还能补推，不把改动当"已同步" */
      settleWaiters(false, epoch);
      return false;
    });
}

/* epoch = 本次落地推送所属的会话。跨会话的等待者一律按「未落地」(false) 收口：
 * 旧账号的推送落地不能替新账号的等待者报成功，也不能让它一直挂着（登出流程
 * 靠这个 promise 决定何时清身份，挂住就只能等 5s 超时）。 */
function settleWaiters(ok, epoch) {
  var ws = pushWaiters;
  pushWaiters = [];
  for (var i = 0; i < ws.length; i++) {
    var w = ws[i];
    w.resolve(epoch !== undefined && w.epoch !== epoch ? false : ok);
  }
}

var pushDebounced = null;

/* 未推送的本地改动标记。
 * 为什么需要它：markDirty 到真正 pushNow 之间有 2.5s 防抖，
 * 这期间 syncStatus 仍是 "idle"。如果 pullIfSafe 只看 syncStatus，
 * 就会把还没推上去的本地改动当成"已同步"从而被云端覆盖
 * （真实场景：改完笔记立刻切 tab，onShow 里的 pullIfSafe(false) 会把改动抹掉）。 */
var dirtyPending = false;

function markDirty() {
  /* 由「净」转「脏」时记下此刻的云端水位：这一批本地改动是基于哪一版云端的。
   * 必须只在转折点记，后续同批编辑不能覆盖它——否则「期间他端推过新快照」
   * 这个事实会被自己的编辑抹掉，分叉守卫就失效了。 */
  if (!dirtyPending) {
    dirtyBaseCloudAt = lastCloudAt;
    writeFlag(dirtyBaseKey(), dirtyBaseCloudAt);
  }
  dirtyPending = true;
  editSeq += 1; // 在途推送据此得知自己带的是旧快照
  writeFlag(dirtyKey(), true);
  saveLocalSoon(); // 写盘防抖：高频路径上不再每次都做 MB 级 JSON 序列化
  /* 分叉未决（notifyConflict 已置 conflictFork）：自动推送会把本地整包推上云、
   * 静默替换他端新快照——pullIfSafe 的分叉守卫只拦「拉取触发的推送」，拦不住
   * 这条防抖路径。保持脏标记，等用户在「我的 → 数据」手动二选一（「推送到
   * 云端」走 pushNow 不受此门影响；「从云端恢复」经 adoptCloud 清 conflictFork），
   * 之后下一次 markDirty 恢复自动推送。 */
  if (conflictFork) return;
  if (!pushDebounced) {
    pushDebounced = util.debounce(function () {
      pushNow();
    }, 2500);
  }
  pushDebounced();
}

/* 登录后：先看本机缓存（秒开），再对齐云端（云端为准——但本地未推送改动优先） */
function onLogin(userId) {
  /* 身份切换即换代：上一账号（或未登录态）发起的在途拉取/推送，其响应回来时
   * 代数已不符，会被 pullIfSafe/pushNow 丢弃，不再污染本账号的 state 与缓存。
   * 只在身份真的变化时自增：冷启动时 app.js 与页面 probe 可能对同一账号各调一次
   * onLogin，无条件自增会把先发起那次（可能已成功）的拉取误判成 stale。 */
  if (state.userId !== userId) {
    sessionEpoch += 1;
    /* 换账号必须先清掉上一账号的内存态：loadLocal() 在新账号本机没有缓存时返回
     * false 而**不覆写** state，上一账号的 goals/knowledge/books/sessions 会原样
     * 留在内存里——新账号既看到别人的数据，pullIfSafe 还会把「本机有数据」当真，
     * 在新账号云端为空时把上一账号的整份快照反推上它的云端（跨账号数据串味）。
     * 这条路径真实存在：会话失效时 app.js 只 clearSession + reLaunch 登录页，
     * 并不经过 onLogout/resetState。 */
    state.goals = [];
    state.knowledge = [];
    state.books = [];
    state.sessions = [];
    state.customPersonas = [];
    state.folders = [];
    state.settings = {};
  }
  state.userId = userId;
  loadLocal();
  /* 关键：不能在这里把 dirtyPending 清零。
   * 旧实现先清标记再 force 拉取，弱网/冷启动时云端旧快照会静默覆盖本地未推送编辑。
   * 标记与水位都从本机持久化恢复，跨进程也守得住。 */
  dirtyPending = readFlag(dirtyKey()) === true || readFlag(dirtyKey()) === "1";
  lastCloudAt = readFlag(cloudAtKey()) || "";
  /* 遗留脏标记的基准水位也要从本机恢复：没有它就无法判断「上次失败后他端是否
   * 推过新快照」，pullIfSafe 只能退化成整包覆盖。 */
  dirtyBaseCloudAt = readFlag(dirtyBaseKey()) || "";
  conflictNotified = false;
  conflictFork = false; /* 换登录会话：旧分叉态不跨账号，本次 force-pull 重新判定 */
  return pullIfSafe(true);
}

/* 云端对齐。force=true（登录时）：云端空+本机有数据 → 反推修复；
 * 非 force（回前台）：本地有未推送改动时绝不拉取覆盖。
 *
 * 拉取节流：快照是**全量**的（目标+笔记+书+会话），知识库大时是 MB 级。
 * 每个 tab 页 onShow 都调 pullIfSafe —— 之前每切一次 tab 就在当前
 * （往往很慢的）网络通道上重拉一遍全量数据，这是"点 tab 特别卡"的
 * 网络层来源。非 force 时 30s 内不重复拉；下拉刷新/登录不受限。
 *
 * 节流之外还要在途去重：lastPullAt 只在成功回调里更新，首次全量拉取完成前
 * （弱网下数秒，正是节流针对的场景）每次 tab onShow 都能穿过节流检查，各自
 * 发起一次 MB 级全量请求——重复带宽、服务端读放大。在途请求直接复用。 */
var PULL_MIN_INTERVAL = 30 * 1000;
var lastPullAt = 0;
var pullInFlight = null;

/* 「本机未推送改动基于哪一版云端」：markDirty 由净转脏时记下当时的云端水位。
 * 遗留脏标记（上次进程推送失败）单独存在时无法判断本机快照是否已经过时——
 * 只有拿它和云端当前水位比，才知道期间有没有他端推过新快照。 */
var dirtyBaseCloudAt = "";

function pullIfSafe(force, opts) {
  if (!state.userId) return Promise.resolve("skip");
  /* 用户显式选择「从云端恢复」：这是他看过提示后主动放弃本机未推送改动，
   * 必须能穿过下面的脏标记守卫（否则分叉时永远 adopt 不了云端）。 */
  var explicitRestore = Boolean(opts && opts.restore);
  var now = Date.now();
  if (!force && now - lastPullAt < PULL_MIN_INTERVAL) {
    return Promise.resolve("skip");
  }
  /* 在途去重：拉的是同一份云端快照，force 也复用（避免首拉完成前并发重拉）。
   * 必须带会话代数：换账号后上一账号的在途拉取不能顶替新账号的拉取（它会被
   * 会话围栏判 stale，新账号就永远拿不到数据）。
   * 显式「从云端恢复」不复用：在途那次是普通拉取，其守卫分支不含 restore 语义，
   * 直接返回 "conflict" 会让用户点了恢复却什么都没发生。 */
  if (!explicitRestore && pullInFlight && pullInFlight.epoch === sessionEpoch) {
    return pullInFlight.promise;
  }
  /* 记下发起时的会话代数：拉取最长 60s（api.js 的 timeout），期间完全可能
   * 登出并换账号登录。响应回来若代数已变，这份快照属于旧账号，必须整份丢弃。 */
  var epoch = sessionEpoch;
  var p = api
    .pullCloud()
    .then(function (cloud) {
      /* 会话围栏（比 userId 判空更严）：旧会话的迟到响应既不能 adoptCloud 写进
       * 新账号的 state/本机缓存，也不能继续往下走 pushNow——那会把旧账号的全量
       * 快照反推上新账号的云端。 */
      if (epoch !== sessionEpoch) return "stale";
      lastPullAt = Date.now();
      /* 本地有未推送改动（含防抖窗口、在途推送、上次离线遗留）→ 绝不覆盖本地。
       * 注意这条守卫不再被 force 短路：登录时的强拉也要让位给本地真实改动。
       *
       * 但「不覆盖本地」不等于「无条件整包推本地」：遗留脏标记来自上一次进程里
       * 失败的推送（弱网时它会一直留着），这期间他端（Web）可能已经推了新快照。
       * 此时整包推上去 = 静默替换云端活跃快照，他端新工作从运行态消失（只能靠
       * 服务端 versions/ 回捞）。所以先比一次基准水位：本机改动所基于的云端版本
       * （dirtyBaseCloudAt，缺省回落 lastCloudAt）比云端当前版本旧，说明两端已经
       * 分叉 → 不自动推也不 adopt，报 "conflict" 并明确告知，由用户手动二选一
       * （我的 → 从云端恢复 / 推送到云端）。两端数据都原样保留。
       *
       * 守卫前提是「本机内存态可信」：hasLocalData() 只数五类条目，删光最后
       * 一条会话/笔记的用户 hasLocalData()=false 但改动是真实的（removeSession
       * 置了脏标记）——此前守卫整体跳过，云端旧快照把「删光」静默回滚。
       * localLoaded（本机缓存 JSON 解析成功过）补上这一档；而缓存缺失/损坏
       * （localLoaded=false）时内存空可能是假的，保持原样跳过守卫走 adopt，
       * 绝不自动整包推空快照盖云端。 */
      if (
        !explicitRestore &&
        (hasLocalData() || localLoaded) &&
        (dirtyPending || pushing || syncStatus === "saving")
      ) {
        /* 分叉判定只针对「遗留脏标记」：正在推送（pushing / saving）说明本机改动
         * 正在上云，此时水位比云端旧是正常的（云端时间戳来自别的端，本端还没落地），
         * 不能据此判分叉——照常走 pushNow 排空即可。 */
        var staleDirty = dirtyPending && !pushing && syncStatus !== "saving";
        var base = dirtyBaseCloudAt || lastCloudAt;
        if (
          staleDirty &&
          cloud &&
          cloudHasData(cloud.data) &&
          cloud.updatedAt &&
          base &&
          cloud.updatedAt > base
        ) {
          notifyConflict();
          return "conflict";
        }
        return pushNow().then(function (ok) {
          return ok ? "pushed" : "error";
        });
      }
      if (!cloud || !cloudHasData(cloud.data)) {
        if (hasLocalData()) {
          return pushNow().then(function (ok) {
            return ok ? "pushed" : "error";
          });
        }
        /* 云端空 + 本机缓存也读不出：这不是「还没有数据」，是本机唯一的副本可能
         * 已损坏。报 "error" 让同步徽章与页面 toast 可见，而不是渲染成空态。 */
        return localLoadFailed ? "error" : "none";
      }
      /* 水位守卫：云端时间不比上次见到的更新，就不是"云端有更新"，
       * 不采用（防并发回滚/服务端脏快照把本地降级）。
       * 用户显式「从云端恢复」时跳过：他要的就是当前云端那一版，哪怕它比本机
       * 记的水位旧（例如水位被上一台设备的推送抬高过）。 */
      if (!explicitRestore && lastCloudAt && cloud.updatedAt && cloud.updatedAt < lastCloudAt) {
        return "none";
      }
      /* 水位相等 = 本机见过的就是这一版，内容无变化：走到这里的前提是上面的
       * 脏守卫已放行（无未推送改动），本机缓存读取成功时内存态就是水位对应的
       * 快照——再整份 adoptCloud 是 30s 级热路径（每次回前台/切 tab 的拉取）
       * 上白做的 MB 级 stringify + 全量 state 替换，正是 saveLocalSoon 为高频
       * 写路径消灭的同一类开销。本机缓存读不出（localLoadFailed）时不短路：
       * adoptCloud 是坏缓存自愈的唯一通道，照常采用。 */
      if (
        !explicitRestore &&
        lastCloudAt &&
        cloud.updatedAt &&
        cloud.updatedAt === lastCloudAt &&
        !localLoadFailed
      ) {
        return "none";
      }
      adoptCloud(cloud.data);
      if (cloud.updatedAt) {
        lastCloudAt = cloud.updatedAt;
        writeFlag(cloudAtKey(), lastCloudAt);
      }
      /* 已收口到云端版本：本机改动基准跟着推进，避免下一次 markDirty 拿旧基准
       * 判定出假分叉。 */
      dirtyBaseCloudAt = lastCloudAt;
      writeFlag(dirtyBaseKey(), dirtyBaseCloudAt);
      return "pulled";
    })
    .catch(function (err) {
      /* 旧会话的失败与当前账号无关，报成 "error" 会让新账号看到假的同步失败 */
      if (epoch !== sessionEpoch) return "stale";
      /* 会话被服务端吊销（Web 端改密/重置密码 bump sv、30 天过期、账号注销）时
       * /api/sync 返回 401（requestJson 会带 statusCode），这不是网络故障。
       * 报成 "error" 会让调用方弹「请检查网络」且永不自愈，报 "unauthorized"
       * 让调用方走清会话回登录页的自愈路径。 */
      if (err && err.statusCode === 401) return "unauthorized";
      return "error";
    });
  pullInFlight = { epoch: epoch, promise: p };
  /* 无论结果如何都清掉在途标记（不用 finally：小程序 ES5 风格保持零依赖） */
  var clear = function () {
    if (pullInFlight && pullInFlight.promise === p) pullInFlight = null;
  };
  p.then(clear, clear);
  return p;
}

/* 分叉提示：不自动覆盖任何一端，明确告诉用户去哪里手动选择。
 * 只在真的会丢数据时弹一次（同一次分叉不重复弹，避免每次 onShow 都打扰）。
 * toast 是一次性的且会被微信截断（icon:none 约 2 行），所以同时做两件事收口：
 *  · conflictFork = true：撤掉挂起的防抖推送 + 拦住后续 markDirty 的自动推送
 *    （否则用户没看到提示继续编辑时，本地整包会静默盖到云端，脏守卫上方注释自述
 *    的正是这个后果）。手动「推送到云端」（profile.pushNow）不受影响。
 *  · emitStatus("conflict")：overview/profile 的同步徽章持久显示，不再依赖
 *    用户恰好看见了那条 toast。 */
var conflictNotified = false;
var conflictFork = false;
function notifyConflict() {
  if (conflictNotified) return;
  conflictNotified = true;
  conflictFork = true;
  if (pushDebounced) pushDebounced.cancel();
  try {
    if (typeof wx !== "undefined" && typeof wx.showToast === "function") {
      wx.showToast({
        title: "云端已有他端更新：请到「我的 → 数据」二选一",
        icon: "none",
        duration: 4000
      });
    }
  } catch (e) { /* 提示失败不影响数据安全：两端都没被改动 */ }
  emitStatus("conflict");
}

function flushPush() {
  if (saveTimer) {
    // 待写的本地快照立即落盘（切后台前保证本机缓存完整）
    saveLocal();
  }
  /* 撤掉挂起的推送防抖，下面立即推 */
  if (pushDebounced) pushDebounced.cancel();
  /* 分叉未决时切后台也不自动推：这里推上去同样是拿本地整包静默替换他端
   * 新快照。脏标记还在，下次登录的 force-pull 会重新走分叉判定。 */
  if (state.userId && !conflictFork) pushNow();
}

function onLogout() {
  var uid = state.userId;
  if (!uid) {
    resetState();
    return Promise.resolve();
  }
  saveLocal(); // 退出前保证本机缓存完整
  if (pushDebounced) pushDebounced.cancel(); // 登出后不再触发防抖推送
  /* 等推送真正落地再清身份：旧实现直接清 userId，重入的 pushNow 在开头就放弃，
   * 登出前最后几秒的改动永远上不了云，下次登录又被 force-pull 覆盖成永久丢失。
   * 最多等 5s：网络卡死也不能把用户卡在登出页——脏标记还在，下次登录会补推。 */
  var landed =
    dirtyPending || pushing || pendingPush ? pushNow() : Promise.resolve(true);
  var timeout = new Promise(function (resolve) {
    setTimeout(function () {
      resolve(false);
    }, 5000);
  });
  return Promise.race([landed, timeout]).then(function () {
    resetState();
  });
}

function resetState() {
  /* 登出即换代：在途拉取/推送的迟到响应不得再写 state 或本机缓存。
   * 尤其重要——登出后同进程换账号登录，旧账号响应会落在新账号的 cacheKey 上。 */
  sessionEpoch += 1;
  state.userId = null;
  state.goals = [];
  state.knowledge = [];
  state.books = [];
  state.sessions = [];
  state.customPersonas = [];
  state.folders = [];
  state.settings = {};
  conflictFork = false; /* 登出即换代：分叉态不跨账号 */
  /* 不清 dirty/水位存储：它们按 userId 命名，推送失败时下次登录还要靠它补推 */
}

/* ---------------- 派生选择器 ---------------- */

function activeGoal() {
  for (var i = 0; i < state.goals.length; i++) {
    if (state.goals[i].status === "active") return state.goals[i];
  }
  return null;
}

function dueReviews() {
  var today = util.todayISO();
  return state.knowledge.filter(function (k) {
    return k.nextReviewAt && k.nextReviewAt <= today;
  });
}

function goalById(id) {
  for (var i = 0; i < state.goals.length; i++) {
    if (state.goals[i].id === id) return state.goals[i];
  }
  return null;
}

function knowledgeById(id) {
  for (var i = 0; i < state.knowledge.length; i++) {
    if (state.knowledge[i].id === id) return state.knowledge[i];
  }
  return null;
}

function bookById(id) {
  for (var i = 0; i < state.books.length; i++) {
    if (state.books[i].id === id) return state.books[i];
  }
  return null;
}

function sessionById(id) {
  for (var i = 0; i < state.sessions.length; i++) {
    if (state.sessions[i].id === id) return state.sessions[i];
  }
  return null;
}

/* ---------------- 写路径（复刻 Web store 语义） ---------------- */

/* 通过某天后解锁同阶段下一天 / 下一阶段首天。
 * 返回值：本次推进是否把整个目标走完了（true = 最后一个阶段最后一天）。
 *
 * 注意（曾经的真 bug）：早期版本在这里直接给传入的 goal 赋 status="done"，
 * 而调用方传的是一个临时 shadow 对象——赋值落在临时对象上，真实 goal 永远停在
 * active，导致「目标永远完不成」：首页一直显示进行中、结业回路永不触发。
 * 现在改为**返回结论**，由调用方写回真实 goal，不依赖对象引用。 */
function unlockNext(goal, dayId) {
  if (!goal.plan) return false;
  var day = goal.plan.days[dayId];
  if (!day) return false;
  var phase = null;
  for (var i = 0; i < goal.plan.phases.length; i++) {
    if (goal.plan.phases[i].id === day.phaseId) phase = goal.plan.phases[i];
  }
  if (!phase) return false;
  var idx = phase.dayIds.indexOf(dayId);
  if (idx >= 0 && idx < phase.dayIds.length - 1) {
    var next = goal.plan.days[phase.dayIds[idx + 1]];
    if (next && next.status === "locked") next.status = "active";
    return false;
  }
  phase.status = "passed";
  var pIdx = goal.plan.phases.indexOf(phase);
  var nextPhase = goal.plan.phases[pIdx + 1];
  if (nextPhase && nextPhase.status === "locked") {
    nextPhase.status = "active";
    var first = goal.plan.days[nextPhase.dayIds[0]];
    if (first && first.status === "locked") first.status = "active";
    return false;
  }
  // 没有下一阶段了 → 整个目标走完
  return !nextPhase;
}

/* 返回值：是否真的写入了。目标/学习日已被他端删除时返回 false——调用方据此
 * 决定是否 toast「成功」，不能对空操作报成功（day.js commitTransfer/forceSkip）。 */
function setDayStatus(goalId, dayId, status, opts) {
  var goal = goalById(goalId);
  if (!goal || !goal.plan) return false;
  var plan = util.clone(goal.plan);
  var day = plan.days[dayId];
  if (!day) return false;
  day.status = status;
  day.completedAt = status === "active" ? undefined : util.todayISO();
  var gate = status === "passed" && opts && opts.pendingUnlock;
  if (gate) {
    day.pendingUnlock = true;
    day.transferQuestion = (opts && opts.transferQuestion) || "";
  } else if (status === "passed") {
    delete day.pendingUnlock;
  }
  var shadow = { id: goal.id, plan: plan };
  if ((status === "passed" && !gate) || status === "skipped") {
    if (unlockNext(shadow, dayId)) goal.status = "done";
  }
  goal.plan = plan;
  if (goal.status === "done" && !goal.graduatedAt && !goal.needsGraduation) {
    goal.needsGraduation = true;
  }
  markDirty();
  return true;
}

/* 返回值同 setDayStatus：day 不存在 / 还没 passed 时返回 false，
 * 调用方不能对未发生的解锁报「下一天已解锁」。 */
function completeTransfer(goalId, dayId, answer) {
  var goal = goalById(goalId);
  if (!goal || !goal.plan) return false;
  var plan = util.clone(goal.plan);
  var day = plan.days[dayId];
  if (!day || day.status !== "passed") return false;
  day.pendingUnlock = false;
  day.transferAnswer = answer;
  var shadow = { id: goal.id, plan: plan };
  if (unlockNext(shadow, dayId)) goal.status = "done";
  goal.plan = plan;
  if (goal.status === "done" && !goal.graduatedAt) goal.needsGraduation = true;
  markDirty();
  return true;
}

/* 注意：生产链路已不用它（day.js 走 applyQuizPass 一次写全）。
 * 保留导出仅为 scripts/smoke-mp-core.cjs 的「attempts++」冒烟断言；不要在新的
 * 写路径里调用它，否则又是一次 plan 深拷贝 + 一次 markDirty。 */
function incrementAttempts(goalId, dayId) {
  var goal = goalById(goalId);
  if (!goal || !goal.plan || !goal.plan.days[dayId]) return;
  var plan = util.clone(goal.plan);
  var day = plan.days[dayId];
  if (day) day.attempts = (day.attempts || 0) + 1;
  goal.plan = plan;
  markDirty();
}

/* 验收记录裁剪：全量快照同步 + >4.5MB 服务端硬拒，quizLog 无界增长最终会
 * 让「推不上云」变成「本机缓存也静默停写」，丢掉此后的全部编辑。
 * 只留最近 200 次，题干/答案/反馈各截 600 字（原记录仍能在当天视图回看）。 */
var QUIZ_LOG_MAX = 200;
var QUIZ_TEXT_MAX = 600;

function trimQuizResult(r) {
  if (!r || !Array.isArray(r.items)) return r;
  return Object.assign({}, r, {
    items: r.items.slice(0, 12).map(function (it) {
      return Object.assign({}, it, {
        question: String(it.question || "").slice(0, QUIZ_TEXT_MAX),
        userAnswer: String(it.userAnswer || "").slice(0, QUIZ_TEXT_MAX),
        feedback: String(it.feedback || "").slice(0, QUIZ_TEXT_MAX)
      });
    })
  });
}

function logQuiz(goalId, result) {
  var goal = goalById(goalId);
  if (!goal) return;
  goal.quizLog = [trimQuizResult(result)].concat(goal.quizLog || []).slice(0, QUIZ_LOG_MAX);
  markDirty();
}

/* ---- 第二大脑：MOC 目录 + 双链解析（Web store 同语义简化版） ---- */

function mocTitle(subject) {
  return subject + " · 目录";
}

function withMoc(knowledge, subject) {
  if (!subject) return knowledge;
  var title = mocTitle(subject);
  var members = [];
  for (var i = 0; i < knowledge.length; i++) {
    var k = knowledge[i];
    if ((k.domain || "").split("/")[0] === subject && k.title !== title) {
      members.push(k);
    }
  }
  var body =
    "# " + subject + " · 目录\n\n> 自动维护的索引（MOC）：本科目下所有笔记都挂在这里,点链接跳转,新笔记自动加入。\n\n" +
    members
      .map(function (m) {
        return "- [[" + m.title + "]]";
      })
      .join("\n");
  var hit = null;
  for (var j = 0; j < knowledge.length; j++) {
    /* 只认自动生成的目录（tags 含 "MOC"）：用户/AI 恰好建过同名
     * 「<科目> · 目录」普通笔记时，标题相等不足以证明它就是我们维护的
     * 索引——命中后 nk.body = body 会把用户笔记原文无声覆盖。tag 不符时
     * 不命中，withMoc 会另建一张真正的 MOC（同名两篇，用户笔记保留原文）。 */
    if (knowledge[j].title === title && (knowledge[j].tags || []).indexOf("MOC") >= 0) {
      hit = knowledge[j];
    }
  }
  if (hit) {
    if (hit.body === body) return knowledge;
    return knowledge.map(function (k) {
      if (k.id === hit.id) {
        var nk = util.clone(k);
        nk.body = body;
        nk.updatedAt = new Date().toISOString();
        return nk;
      }
      return k;
    });
  }
  var moc = {
    id: util.uid("k"),
    title: title,
    body: body,
    domain: subject,
    source: "manual",
    sourceTitle: "自动目录",
    masteredAt: util.todayISO(),
    reviewStage: 0,
    links: [],
    tags: ["MOC"],
    version: 1,
    updatedAt: new Date().toISOString()
  };
  return [moc].concat(knowledge);
}

function linkifyBodies(knowledge) {
  var byTitle = {};
  for (var i = 0; i < knowledge.length; i++) {
    if (!knowledge[i].unresolved) {
      byTitle[(knowledge[i].title || "").trim().toLowerCase()] = knowledge[i].id;
    }
  }
  var re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  return knowledge.map(function (k) {
    var found = [];
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(k.body || ""))) {
      var id = byTitle[m[1].trim().toLowerCase()];
      if (id && id !== k.id && found.indexOf(id) < 0) found.push(id);
    }
    if (!found.length) return k;
    var merged = (k.links || []).slice();
    for (var j = 0; j < found.length; j++) {
      if (merged.indexOf(found[j]) < 0) merged.push(found[j]);
    }
    if (merged.length === (k.links || []).length) return k;
    var nk = util.clone(k);
    nk.links = merged;
    return nk;
  });
}

/* 知识入库统一通道（Web addKnowledge 同语义）：按标题去重、learn/read 进复习队列、
 * MOC 目录重算、双链解析。addLearnKnowledge 与读书沉淀（recap/迁移实践）都走这里。 */
function ingestKnowledge(items, source, sourceTitle) {
  var existing = {};
  state.knowledge.forEach(function (k) {
    existing[k.title] = true;
  });
  var fresh = [];
  (items || []).forEach(function (it) {
    if (!it.title || existing[it.title]) return;
    existing[it.title] = true;
    fresh.push({
      id: util.uid("k"),
      title: it.title,
      body: it.body || "",
      domain: it.domain,
      source: source,
      sourceTitle: sourceTitle,
      knowledgeType: it.knowledgeType,
      masteryStatus: it.masteryStatus,
      masteredAt: util.todayISO(),
      reviewStage: 0,
      /* Web 同口径：只有 learn/read 产出的知识点自动进复习队列 */
      nextReviewAt: source === "learn" || source === "read" ? util.todayISO() : undefined,
      links: [],
      version: 1,
      updatedAt: new Date().toISOString()
    });
  });
  if (fresh.length === 0) return 0;
  var next = fresh.concat(state.knowledge);
  var subjects = {};
  fresh.forEach(function (f) {
    subjects[(f.domain || "").split("/")[0]] = true;
  });
  Object.keys(subjects).forEach(function (subj) {
    next = withMoc(next, subj);
  });
  state.knowledge = linkifyBodies(next);
  markDirty();
  return fresh.length;
}

/* 验收通过：知识点进第二大脑 + 间隔复习队列（Web addKnowledge 的 learn 路径） */
function addLearnKnowledge(goal, day, mStatus) {
  return ingestKnowledge(
    (day.knowledgePoints || [])
      .filter(function (kp) {
        return kp.text;
      })
      .map(function (kp) {
        return {
          title: kp.text,
          body: "",
          domain: goal.topic + "/笔记",
          knowledgeType: kp.knowledgeType,
          masteryStatus: mStatus
        };
      }),
    "learn",
    goal.topic + " · " + day.title
  );
}

/* 验收通过一次写全（day.js 用）：attempts+1、passed+迁移门、知识点掌握度。
 * 此前三步各 util.clone 一份 plan 串行执行，大 plan 主线程可感卡顿——合并在一次 clone 里。
 * （旧的 updatePlanKpMastery 分步实现已被本函数取代并删除；incrementAttempts
 *  仍保留导出供冒烟脚本使用，见其函数头注释——不要在新写路径里调用。） */
function applyQuizPass(goalId, dayId, mStatus, transferQuestion) {
  var goal = goalById(goalId);
  if (!goal || !goal.plan || !goal.plan.days[dayId]) return;
  var plan = util.clone(goal.plan);
  var day = plan.days[dayId];
  day.attempts = (day.attempts || 0) + 1;
  day.status = "passed";
  day.completedAt = util.todayISO();
  day.pendingUnlock = true;
  day.transferQuestion = transferQuestion || "";
  var kps = (day.knowledgePoints || []).slice();
  for (var i = 0; i < kps.length; i++) {
    kps[i].masteryStatus = mStatus;
    if (
      !kps[i].historicalHighest ||
      masteryMod.ORDER.indexOf(mStatus) >
        masteryMod.ORDER.indexOf(kps[i].historicalHighest)
    ) {
      kps[i].historicalHighest = mStatus;
    }
  }
  day.knowledgePoints = kps;
  goal.plan = plan;
  markDirty();
}

/* 复习完成：经典 1/3/7/15/30 档（不写 fsrs 字段，Web 端 FSRS 可无缝接管）。
 * 掌握推进与 Web masteryFromReview 同规则：passReps=通过轮次、stability=当前间隔。 */
function recordReview(id, ok) {
  var k = knowledgeById(id);
  if (!k) return;
  var stage = k.reviewStage || 0;
  var nextStage;
  var interval;
  if (ok) {
    nextStage = Math.min(stage + 1, INTERVALS.length - 1);
    interval = INTERVALS[nextStage];
  } else {
    nextStage = 0;
    interval = 1;
  }
  k.lastReviewOk = ok;
  k.reviewStage = nextStage;
  k.nextReviewAt = util.addDays(interval);
  if (ok) {
    var cur = k.masteryStatus || "unknown";
    var passReps = nextStage;
    var stability = interval;
    var updated = cur;
    if (cur === "unknown" || cur === "exposed") {
      if (passReps >= 1) updated = "guided";
    } else if (cur === "guided") {
      if (passReps >= 2) updated = "independent";
    } else if (cur === "independent" || cur === "transferable") {
      if (passReps >= 4 && stability >= 21) updated = "durable";
    }
    k.masteryStatus = updated;
  }
  markDirty();
}

/* ---------------- 读书伙伴 ---------------- */

function updateBook(id, patch) {
  state.books = state.books.map(function (b) {
    if (b.id !== id) return b;
    var nb = util.clone(b);
    Object.keys(patch).forEach(function (key) {
      nb[key] = patch[key];
    });
    return nb;
  });
  markDirty();
}

/* 消息数组上限（会话 / 读书聊天 / 每日答疑共用同一口径，见 util.capMessages）。
 * 为什么必须裁：快照是全量同步的，服务端 4.2MB 硬拒（sync/route.ts MAX_BODY_BYTES），
 * 微信 setStorageSync 单 key 还有 1MB 上限；三个数组都是无界 concat，
 * 活跃用户数月后就会撞穿上限 → saveLocal 抛错被吞、本机缓存静默停写，
 * 此后所有编辑只活在内存里（quizLog 已因同一原因修过，见上方 QUIZ_LOG_MAX）。 */
var MSG_MAX = 100;

/* 书本内记录的条数上限（验收档案 / 沉淀 / 学习证据）：与消息数组同一原因——
 * 全量快照同步 + 4.2MB 硬闸 + 单 key 1MB，无界 concat 迟早把推/拉一起拖死。
 * 200 条足够回看近几个月的记录，更早的本来也不会被页面渲染。 */
var BOOK_RECORD_MAX = 200;
/* 建档时用户粘贴的原文：只作生成素材与回看，超出部分对模型无用却会永久占体积 */
var PASTED_TEXT_MAX = 20000;

function capList(list, max) {
  return (list || []).slice(0, max || BOOK_RECORD_MAX);
}

/* 追加在尾部增长的数组（learning.evidence）：裁剪必须保尾部（最新证据），
 * 用 slice(0, N) 会把最新的全丢掉、只留最早的一批。 */
function capListTail(list, max) {
  return (list || []).slice(-(max || BOOK_RECORD_MAX));
}

function addBookMsg(id, msg) {
  var b = bookById(id);
  if (!b) return;
  b.chat = util.capMessages((b.chat || []).concat([msg]), MSG_MAX);
  markDirty();
}

/* 由阅读计划草稿建档（task=reading-plan 的产物）。
 * verification（V26.2-H2 书籍真实性，与 Web Book.verification 同语义）：
 * "verified"=搜索核实 / "user_material"=基于用户粘贴材料；不传=旧链路不标记 */
function createBookFromPlan(title, author, pastedText, plan, verification) {
  var chapters = (plan.chapters || []).map(function (c, i) {
    return {
      id: "c" + i + "-" + util.uid(""),
      title: c.title,
      knowledgeType: c.knowledgeType || "concept",
      coreIdea: c.coreIdea || "",
      focusQuestion: c.focusQuestion || "",
      perspectives: c.perspectives || [],
      capture: c.capture || [],
      status: "todo"
    };
  });
  var book = {
    id: util.uid("b"),
    title: title,
    author: author || "",
    /* v25 阅读系统：新链路给 map（认知地图四区域）；旧输出只有 bookProfile——两代都接 */
    map: plan.map
      ? {
          coreProblem: plan.map.coreProblem || "",
          authorStance: plan.map.authorStance || "",
          lineage: plan.map.lineage || "",
          controversies: plan.map.controversies || "",
          generatedAt: new Date().toISOString()
        }
      : undefined,
    profile:
      plan.bookProfile ||
      (plan.map
        ? {
            positioning: plan.map.coreProblem || "",
            author: plan.map.authorStance || "",
            lineage: plan.map.lineage || "",
            controversies: plan.map.controversies || ""
          }
        : undefined),
    pastedText: String(pastedText || "").slice(0, PASTED_TEXT_MAX),
    status: "reading",
    readStatus: "reading",
    verification: verification || undefined,
    planSummary: plan.planSummary || "",
    chapters: chapters,
    insights: [],
    chat: [],
    createdAt: new Date().toISOString()
  };
  state.books = [book].concat(state.books);
  markDirty();
  return book.id;
}

/* ---------------- 学习教练：目标与计划写路径（Web store 同语义） ---------------- */

function addGoal(goal) {
  state.goals = [goal].concat(state.goals);
  markDirty();
  return goal.id;
}

function updateGoal(goalId, patch) {
  state.goals = state.goals.map(function (g) {
    if (g.id !== goalId) return g;
    var ng = util.clone(g);
    Object.keys(patch).forEach(function (key) {
      ng[key] = patch[key];
    });
    return ng;
  });
  markDirty();
}

/* 阶段天目录落库（Web setPhaseCatalog 同语义）：catalog 一生成就完整可见；
 * 已展开的天只做目录索引不覆盖详情；locked 阶段激活、首天解锁。 */
function setPhaseCatalog(goalId, phaseId, boundary, catalog) {
  var goal = goalById(goalId);
  if (!goal || !goal.plan || !catalog || !catalog.length) return;
  var plan = util.clone(goal.plan);
  var phase = null;
  plan.phases.forEach(function (ph) {
    if (ph.id === phaseId) phase = ph;
  });
  if (!phase) return;
  phase.catalog = catalog.map(function (c) {
    return { id: c.id, title: c.title, knowledgePoints: c.knowledgePoints };
  });
  catalog.forEach(function (c) {
    var old = plan.days[c.id];
    var kps = c.knowledgePoints.map(function (text) {
      return { id: util.uid("kp"), text: text };
    });
    if (!old) {
      /* 目录占位：只有标题与清单级知识点，学到那天再展开详情 */
      plan.days[c.id] = {
        id: c.id,
        phaseId: phaseId,
        title: c.title,
        stub: true,
        knowledgePoints: kps,
        resources: [],
        method: "",
        acceptance: [],
        status: "locked",
        attempts: 0
      };
    } else if (old.stub) {
      old.title = c.title;
      old.knowledgePoints = kps;
    }
  });
  phase.dayIds = catalog.map(function (c) {
    return c.id;
  });
  phase.boundary = boundary;
  phase.planned = catalog.every(function (c) {
    return plan.days[c.id] && !plan.days[c.id].stub;
  });
  if (phase.status === "locked") phase.status = "active";
  var first = plan.days[phase.dayIds[0]];
  if (first && first.status === "locked") first.status = "active";
  goal.plan = plan;
  markDirty();
}

/* 单日详情回填（Web setDayDetail 同语义）：覆盖细节、保留进度/讲义/答疑等运行态。
 * 返回值：是否真的写入——落点（目标/学习日）缺失时是静默空操作，调用方
 * （day.js expandDetail）不能对没发生的写入报「今天的计划已就绪」。 */
function setDayDetail(goalId, phaseId, dayId, detail) {
  var goal = goalById(goalId);
  if (!goal || !goal.plan) return false;
  var plan = util.clone(goal.plan);
  var phase = null;
  plan.phases.forEach(function (ph) {
    if (ph.id === phaseId) phase = ph;
  });
  var old = plan.days[dayId];
  if (!phase || !old) return false;
  var catTitle = "";
  (phase.catalog || []).forEach(function (c) {
    if (c.id === dayId && c.title) catTitle = c.title;
  });
  var merged = Object.assign({}, detail, {
    id: dayId,
    phaseId: phaseId,
    stub: false,
    title: catTitle || detail.title,
    /* 进度与学习痕迹属于运行态，回填细节时原样保留 */
    status: old.status,
    completedAt: old.completedAt,
    attempts: old.attempts,
    lesson: old.lesson,
    qa: old.qa,
    pendingUnlock: old.pendingUnlock,
    transferQuestion: old.transferQuestion,
    transferAnswer: old.transferAnswer
  });
  plan.days[dayId] = merged;
  /* 「阶段有哪些天」的判定与 goal.js 渲染共用 util.phaseDayIds（catalog 优先、
   * 老目标回落 dayIds）：手写第三份变体时改一处漏一处就会让渲染与落库口径分裂。 */
  var ids = util.phaseDayIds(phase);
  phase.planned = ids.every(function (id) {
    return plan.days[id] && !plan.days[id].stub;
  });
  goal.plan = plan;
  markDirty();
  return true;
}

/* 单日答疑整体落库（day.js sendQa 用户消息/成功回答/失败标记三处收口）。
 * day.js 此前在这三处手写 util.clone(goal.plan)→改→goal.plan=plan→markDirtyPublic
 * 的旁路写法——写纪律在页面复制三份后开始漏改（expandDetail 报成功前不核验写入），
 * 且旁路永远拿不到写入失败信号，只能靠每个调用点自觉重查 goalById。
 * 收口到数据层（与 setDayStatus/completeTransfer 同一签名纪律）：
 * 返回值：是否真的写入——落点（目标/学习日）缺失时是静默空操作，
 * 调用方不能对没发生的写入报成功，必须给「这条回答没能保存」式的可见交代。
 * qa 由调用方组合（含 util.capMessages 裁剪），本方法只负责原子写入。 */
function setDayQa(goalId, dayId, qa) {
  var goal = goalById(goalId);
  if (!goal || !goal.plan || !goal.plan.days[dayId]) return false;
  var plan = util.clone(goal.plan);
  plan.days[dayId].qa = qa || [];
  goal.plan = plan;
  markDirty();
  return true;
}

/* 单日讲义落库（day.js saveLesson 收口，语义同 Web saveLesson）。
 * 返回值：是否真的写入——生成讲义的 40-90s 里他端删除目标/adoptCloud 替换后
 * 落点可能已消失，调用方（day.js saveLesson）据此给「这份讲义没能保存」的
 * 可见交代，不再静默丢弃整篇已生成的讲义。 */
function saveDayLesson(goalId, dayId, text) {
  var goal = goalById(goalId);
  if (!goal || !goal.plan || !goal.plan.days[dayId]) return false;
  var plan = util.clone(goal.plan);
  plan.days[dayId].lesson = text;
  goal.plan = plan;
  markDirty();
  return true;
}

/* ---------------- 阅读系统 V1.0：目标/验收/状态机/沉淀 ---------------- */

function findChapter(book, chapterId) {
  var hit = null;
  (book.chapters || []).forEach(function (c) {
    if (c.id === chapterId) hit = c;
  });
  return hit;
}

/* 节点状态机（Web setChapterStatus）：手动标记 done 不写 masteredAt（区别于验收通过） */
function setChapterStatus(bookId, chapterId, status) {
  var b = bookById(bookId);
  if (!b || !findChapter(b, chapterId)) return;
  var nb = util.clone(b);
  nb.chapters = nb.chapters.map(function (c) {
    return c.id === chapterId ? Object.assign({}, c, { status: status }) : c;
  });
  state.books = state.books.map(function (x) {
    return x.id === bookId ? nb : x;
  });
  markDirty();
}

/* 单题验收档案（Web addChapterAssessment）：book 级存储，换路线/重排不丢。
 * 判分器带出 misconception 时同步进 learning.misconceptions（clarified=false 两态语义）。 */
function addChapterAssessment(bookId, record, misconception) {
  var b = bookById(bookId);
  if (!b || !record) return;
  var nb = util.clone(b);
  var rec = Object.assign({ id: util.uid("as"), at: new Date().toISOString() }, record);
  nb.assessments = capList([rec].concat(nb.assessments || []));
  var learning = nb.learning || {
    knownConcepts: [],
    misconceptions: [],
    unresolvedQuestions: [],
    evidence: []
  };
  if (misconception && misconception.concept) {
    learning.misconceptions = capList(
      [
        {
          concept: misconception.concept,
          note: misconception.note || "",
          at: rec.at,
          clarified: false
        }
      ].concat(learning.misconceptions || [])
    );
  }
  nb.learning = learning;
  state.books = state.books.map(function (x) {
    return x.id === bookId ? nb : x;
  });
  markDirty();
}

/* 一次验收提交的合并写全：逐题档案 + 薄弱点 + 掌握标记共用一次整本 clone、
 * 一次 markDirty。页面此前在 results.forEach 里逐条调 addChapterAssessment，
 * 每条都是整本深拷贝 + markDirty，一次提交 3-4 次串行 MB 级 JSON 往返——
 * 正是 applyQuizPass 注释里点名修掉的反模式在 book 链路的残留。
 * misconception 单次提交只补一条（旧逐条写法非掌握题各补一条，同一弱点会重复入列）。
 * mastered = { chapterId, evidence } 或 null（三题全过时由调用方传入）。 */
function addChapterAssessments(bookId, records, misconception, mastered) {
  var b = bookById(bookId);
  if (!b || !records || !records.length) return;
  var nb = util.clone(b);
  var at = new Date().toISOString();
  nb.assessments = capList(
    records.map(function (r) {
      return Object.assign({ id: util.uid("as"), at: at }, r);
    }).concat(nb.assessments || [])
  );
  var learning = nb.learning || {
    knownConcepts: [],
    misconceptions: [],
    unresolvedQuestions: [],
    evidence: []
  };
  if (misconception && misconception.concept) {
    learning.misconceptions = capList(
      [
        {
          concept: misconception.concept,
          note: misconception.note || "",
          at: at,
          clarified: false
        }
      ].concat(learning.misconceptions || [])
    );
  }
  if (mastered && mastered.chapterId && findChapter(nb, mastered.chapterId)) {
    nb.chapters = nb.chapters.map(function (c) {
      return c.id === mastered.chapterId
        ? Object.assign({}, c, { status: "done", masteredAt: at })
        : c;
    });
    learning.evidence = capListTail(
      (learning.evidence || []).concat(
        mastered.evidence
          ? [{ chapterId: mastered.chapterId, text: mastered.evidence, at: at }]
          : []
      )
    );
  }
  nb.learning = learning;
  state.books = state.books.map(function (x) {
    return x.id === bookId ? nb : x;
  });
  markDirty();
}

/* 节点验收通过（Web markChapterMastered）：done + masteredAt + 学习证据。
 * masteredAt 只能来自验收——手动「标记读完」走 setChapterStatus，绝不写它。 */
function markChapterMastered(bookId, chapterId, evidence) {
  var b = bookById(bookId);
  if (!b || !findChapter(b, chapterId)) return;
  var nb = util.clone(b);
  nb.chapters = nb.chapters.map(function (c) {
    return c.id === chapterId
      ? Object.assign({}, c, { status: "done", masteredAt: new Date().toISOString() })
      : c;
  });
  var learning = nb.learning || {
    knownConcepts: [],
    misconceptions: [],
    unresolvedQuestions: [],
    evidence: []
  };
  learning.evidence = capListTail(
    (learning.evidence || []).concat(
      evidence ? [{ chapterId: chapterId, text: evidence, at: new Date().toISOString() }] : []
    )
  );
  nb.learning = learning;
  state.books = state.books.map(function (x) {
    return x.id === bookId ? nb : x;
  });
  markDirty();
}

/* 沉淀（Web addBookDeposit）：七类一句话；question/unresolved 同步进待解决问题 */
function addBookDeposit(bookId, d) {
  var b = bookById(bookId);
  if (!b || !d || !d.type || !String(d.text || "").trim()) return;
  var nb = util.clone(b);
  var rec = { id: util.uid("dp"), type: d.type, text: String(d.text).trim(), at: new Date().toISOString() };
  if (d.chapterId) rec.chapterId = d.chapterId;
  nb.deposits = capList([rec].concat(nb.deposits || []));
  if (d.type === "unresolved" || d.type === "question") {
    var learning = nb.learning || {
      knownConcepts: [],
      misconceptions: [],
      unresolvedQuestions: [],
      evidence: []
    };
    var q = rec.text;
    var uq = learning.unresolvedQuestions || [];
    learning.unresolvedQuestions = capList(
      uq.indexOf(q) >= 0 ? uq : [q].concat(uq)
    );
    nb.learning = learning;
  }
  state.books = state.books.map(function (x) {
    return x.id === bookId ? nb : x;
  });
  markDirty();
}

/* 整本五态状态机（Web setBookReadStatus）：已读完≠已掌握。
 * finished/mastered 联动 finishedAt/masteredAt 与 status=done；reading 联动 status=reading。 */
function setBookReadStatus(bookId, status) {
  var b = bookById(bookId);
  if (!b) return;
  var patch = { readStatus: status };
  if (status === "finished") patch.finishedAt = b.finishedAt || new Date().toISOString();
  if (status === "mastered") patch.masteredAt = new Date().toISOString();
  if (status === "reading") patch.status = "reading";
  if (status === "mastered" || status === "finished") patch.status = "done";
  updateBook(bookId, patch);
}

/* 读书沉淀入第二大脑（Web saveRecapToBrain 同语义）：source=read、进复习队列、MOC/双链重算 */
function addReadKnowledge(items, sourceTitle) {
  return ingestKnowledge(items, "read", sourceTitle);
}

/* ---------------- 人生伙伴（圆桌/单聊） ---------------- */

function addSession(sess) {
  state.sessions = [sess].concat(state.sessions);
  markDirty();
}

function updateSession(id, patch) {
  state.sessions = state.sessions.map(function (s) {
    if (s.id !== id) return s;
    var ns = util.clone(s);
    Object.keys(patch).forEach(function (key) {
      ns[key] = patch[key];
    });
    return ns;
  });
  markDirty();
}

function addSessionMsg(id, msg) {
  var s = sessionById(id);
  if (!s) return;
  /* 圆桌一轮就写入全部席位发言 + 主持人纪要，是本数组最大的单次写入点；
   * 无界增长会撞穿 4.2MB 同步闸与单 key 1MB 上限（见 addBookMsg 注释）。 */
  s.messages = util.capMessages((s.messages || []).concat([msg]), MSG_MAX);
  markDirty();
}

function removeSession(id) {
  state.sessions = state.sessions.filter(function (s) {
    return s.id !== id;
  });
  markDirty();
}

/* ---------------- 示例目标（与 Web seedSampleGoal 同一份体验数据） ---------------- */

function seedSampleGoal() {
  var kp = function (t) {
    return { id: util.uid("kp"), text: t, knowledgeType: "concept" };
  };
  var day = function (n, title, kps, st) {
    return {
      id: "d" + n,
      phaseId: "p1",
      title: "Day " + n + "：" + title,
      knowledgePoints: kps.map(kp),
      resources: [
        {
          title: "Prompt Engineering Guide（官方）",
          url: "https://www.promptingguide.ai/zh",
          why: "系统性框架，当手册用",
          kind: "doc",
          year: 2025
        },
        {
          title: "Learn Prompting（免费开源课）",
          url: "https://learnprompting.org/zh/docs/introduction",
          why: "小步interactive",
          kind: "course",
          year: 2025
        }
      ],
      method: "读官方小节→写一个最小 prompt→跑一遍→按验收双轨自测",
      acceptance: [
        {
          id: util.uid("a"),
          kind: "explain",
          question: "用自己的话说清：什么是 zero-shot / few-shot，差别在哪"
        },
        {
          id: util.uid("a"),
          kind: "apply",
          question: "写一个让模型稳定输出 JSON 的 prompt，并贴出你跑通的结果"
        }
      ],
      status: st,
      attempts: 0,
      lesson:
        st === "active"
          ? "## 今日任务与用户背景\n体验示例目标：把一个真实小技能走完「学习→产出→验收」闭环。\n\n## ① 直接可学的资料\n- [Prompt Engineering Guide 中文版](https://www.promptingguide.ai/zh) —— 先读 Zero-Shot 与 Few-Shot 两节\n- [Learn Prompting 入门](https://learnprompting.org/zh/docs/introduction) —— 只看 Basics\n\n## ② 知识点穷尽\n- **zero-shot**：不给例子，直接下指令。适合任务边界清晰、模型见过的套路\n- **few-shot**：给 2-3 个输入输出示例，让模型模仿格式\n- **角色设定**：一句\"你是…\"能显著稳定输出风格\n- **输出约束**：明确\"只输出 JSON/不超过 100 字\"比事后修剪省一半时间\n\n## ③ 完整可运行示例\n\n```text\n你是产品文案。\n任务：把下面的功能点改写成一条朋友圈文案。\n要求：不超过 50 字，带一个具体场景，不要形容词堆砌。\n功能点：离线可用，数据存在本机。\n```\n把上面的 prompt 原样粘进任意对话模型跑一遍，再改功能点重跑。\n\n## ④ 验收\n完成上方\"验收标准\"里的两题，提交评分。"
          : undefined
    };
  };
  var goal = {
    id: util.uid("g"),
    topic: "示例 · Prompt 编写入门",
    direction: "三天走通「学习→产出→验收」闭环（可随时删除）",
    domainKind: "coding",
    motivation: "体验产品流程",
    background: "会用聊天 AI，没系统学过提示词",
    weeklyHours: 3,
    successCriteria: ["走完 Day1-3 并通过验收"],
    status: "active",
    createdAt: new Date().toISOString(),
    quizLog: [],
    intakeTranscript: [],
    plan: {
      startDate: util.todayISO(),
      createdAt: new Date().toISOString(),
      summary: "三天体验闭环：Day1 提示词基础 → Day2 结构化输出 → Day3 小项目验收",
      totalDays: 3,
      weeklyHours: 3,
      phases: [
        {
          id: "p1",
          title: "阶段1 · 体验闭环",
          outcome: "能独立写出结构化 prompt 并通过验收",
          status: "active",
          dayIds: ["d1", "d2", "d3"],
          outline: ["基础", "结构化", "小项目"]
        }
      ],
      days: {
        d1: day(1, "提示词基础：zero-shot / few-shot / 角色", ["zero-shot 与 few-shot 的区别", "角色设定与输出约束"], "active"),
        d2: day(2, "结构化输出与常见坑", ["JSON 输出约束", "失败模式与修复"], "locked"),
        d3: day(3, "小项目：把一个真实需求 prompt 化", ["需求→prompt 的转译"], "locked")
      }
    }
  };
  state.goals = [goal].concat(state.goals);
  markDirty();
  return goal.id;
}

module.exports = {
  state: state,
  onSyncStatus: onSyncStatus,
  markDirtyPublic: markDirty,
  onLogin: onLogin,
  pullIfSafe: pullIfSafe,
  flushPush: flushPush,
  pushNow: pushNow,
  onLogout: onLogout,
  activeGoal: activeGoal,
  dueReviews: dueReviews,
  goalById: goalById,
  knowledgeById: knowledgeById,
  bookById: bookById,
  sessionById: sessionById,
  setDayStatus: setDayStatus,
  completeTransfer: completeTransfer,
  incrementAttempts: incrementAttempts,
  applyQuizPass: applyQuizPass,
  logQuiz: logQuiz,
  addLearnKnowledge: addLearnKnowledge,
  recordReview: recordReview,
  updateBook: updateBook,
  addBookMsg: addBookMsg,
  createBookFromPlan: createBookFromPlan,
  addSession: addSession,
  updateSession: updateSession,
  addSessionMsg: addSessionMsg,
  removeSession: removeSession,
  seedSampleGoal: seedSampleGoal,
  /* 学习教练：目标与计划 */
  addGoal: addGoal,
  updateGoal: updateGoal,
  setPhaseCatalog: setPhaseCatalog,
  setDayDetail: setDayDetail,
  setDayQa: setDayQa,
  saveDayLesson: saveDayLesson,
  /* 阅读系统 V1.0 */
  findChapter: findChapter,
  setChapterStatus: setChapterStatus,
  addChapterAssessment: addChapterAssessment,
  addChapterAssessments: addChapterAssessments,
  markChapterMastered: markChapterMastered,
  addBookDeposit: addBookDeposit,
  setBookReadStatus: setBookReadStatus,
  addReadKnowledge: addReadKnowledge,
  /* 知识入库统一通道（learn/read 源都进复习队列；引导总纲要也走这里） */
  addKnowledgeItems: ingestKnowledge
};
