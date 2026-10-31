/* ========= AI 聊天客户端：/api/chat 的 NDJSON 流式对接 =========
 * 与 Web 端 ai/client.ts 同一协议：
 *   {"t":"d","v":"文本增量"} | {"t":"h","v":"思考心跳"} | {"t":"e","v":"错误"}
 *   | {"t":"p"}（保活 ping，忽略） | {"t":"end"}
 * 小程序侧用 wx.request 的 enableChunked 分块接收，手动解析行。 */
var api = require("./api.js");
var utf8 = require("./utf8.js");

/* 从 LLM 输出中稳健提取 JSON（容忍 ```json 围栏 / 前后缀文本）。
 * 与 Web 端 extractJson 同算法：候选按原文出现位置排序——裸数组 [{...}]
 * 时先命中整个数组而非首个对象。 */
function extractJson(text) {
  var candidates = [];
  var fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());

  var opens = [
    ["{", "}"],
    ["[", "]"]
  ];
  var scanned = [];
  for (var oi = 0; oi < opens.length; oi++) {
    var openCh = opens[oi][0];
    var closeCh = opens[oi][1];
    var start = text.indexOf(openCh);
    if (start === -1) continue;
    var depth = 0;
    var inStr = false;
    var esc = false;
    var end = -1;
    for (var i = start; i < text.length; i++) {
      var ch = text.charAt(i);
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === openCh) depth++;
      else if (ch === closeCh) {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end > start) scanned.push({ start: start, text: text.slice(start, end + 1) });
  }
  scanned.sort(function (a, b) {
    return a.start - b.start;
  });
  for (var si = 0; si < scanned.length; si++) candidates.push(scanned[si].text);
  candidates.push(text.trim());

  for (var ci = 0; ci < candidates.length; ci++) {
    try {
      return JSON.parse(candidates[ci]);
    } catch (e) { /* 试下一个候选 */ }
  }
  throw new Error("无法从模型输出中解析 JSON");
}

/* 流式对话。opts:
 *   task        任务名（服务端按 task 组装系统提示词，客户端不持有模板）
 *   args        纯数据参数
 *   messages    [{role, content}]
 *   temperature 温度
 *   onDelta(delta) 增量回调；onThink(text) 思考心跳
 * 返回 Promise<fullText>；中途收到 t=e 直接 reject（调用方可用已收到的增量做兜底）。 */
function streamChat(opts) {
  return new Promise(function (resolve, reject) {
    var decoder = new utf8.Utf8Decoder();
    var buf = "";
    var full = "";
    var settled = false;
    var streamErr = null;
    var rawAll = "";

    var done = function (err) {
      if (settled) return;
      settled = true;
      try {
        reqTask.abort();
      } catch (e) { /* 已结束 */ }
      if (err) reject(err);
      else resolve(full);
    };

    var handleLines = function (text) {
      buf += text;
      var lines = buf.split("\n");
      buf = lines.pop() || "";
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        var ev = null;
        try {
          ev = JSON.parse(line);
        } catch (e) {
          continue; // 半行，忽略
        }
        if (ev.t === "d" && ev.v) {
          full += ev.v;
          if (opts.onDelta) opts.onDelta(ev.v);
        } else if (ev.t === "h" && ev.v) {
          if (opts.onThink) opts.onThink(ev.v);
        } else if (ev.t === "e") {
          streamErr = new Error(ev.v || "模型返回错误");
          done(streamErr);
          return;
        }
        // t=p 心跳、t=end 收尾：end 由 success 统一收口
      }
    };

    var reqTask = wx.request({
      url: api.requestBaseUrl() + "/api/chat",
      method: "POST",
      enableChunked: true,
      timeout: 180000,
      header: api.authHeaders(),
      data: {
        task: opts.task,
        args: opts.args,
        messages: opts.messages || [],
        temperature: typeof opts.temperature === "number" ? opts.temperature : 0.7
      },
      success: function (res) {
        if (res.statusCode !== 200) {
          var msg = "请求失败（" + res.statusCode + "）";
          try {
            var j = JSON.parse(rawAll);
            if (j && j.error) msg = j.error;
          } catch (e) { /* 非 JSON 响应体 */ }
          done(new Error(msg));
          return;
        }
        if (streamErr) return;
        done(null);
      },
      fail: function (err) {
        done(new Error((err && err.errMsg) || "网络请求失败"));
      }
    });

    if (reqTask && reqTask.onChunkReceived) {
      reqTask.onChunkReceived(function (res) {
        var data = res && res.data;
        if (!data) return;
        try {
          var text;
          if (typeof data === "string") text = data;
          else text = decoder.push(data);
          rawAll += text;
          if (!settled) handleLines(text);
        } catch (e) { /* 解码失败忽略该块 */ }
      });
    } else {
      done(new Error("当前微信基础库不支持流式响应（需 2.20.1+），请升级微信"));
    }
  });
}

module.exports = { streamChat: streamChat, extractJson: extractJson };
