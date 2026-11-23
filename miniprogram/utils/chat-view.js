/* ========= 聊天消息 → 视图结构（唯一实现） =========
 * assistant 消息必须带 blocks（模板按 blocks 渲染 rich-text），user 消息拍平成
 * {role, content}。这组映射此前在 day.js 复制了四处、council.js / book.js 各一份；
 * day.js 里「第一处已修，这里漏了」的注释就是同一 bug 修一处漏三处的代价。
 * 收在这里之后，改渲染口径只改一个文件。 */
function toChatView(messages) {
  /* 惰性取 md：模块级 require 会在本模块首次加载时把当时的实现固定住，
   * 页面测试/热替换 md 之后仍走旧引用。require 本身有缓存，调用开销可忽略。 */
  var md = require("./md.js");
  return (messages || []).map(function (m) {
    if (m.role === "assistant") {
      return { role: "assistant", blocks: md.parse(m.content || "").blocks };
    }
    return { role: "user", content: m.content };
  });
}

module.exports = { toChatView: toChatView };
