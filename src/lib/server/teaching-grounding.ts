import "server-only";

/** Small, relevant factual constraints; no additional model or retrieval request. */
export function teachingGrounding(question:string):string {
  if(!/\brealloc\b/i.test(question))return "";
  return `\n本题已知事实与代码自查（适用于C的非零分配请求）：
- 临时变量接收 realloc 的返回值；原变量在失败时保留旧指针。不能反过来说临时变量保存旧地址。
- 每一个被称为安全/正确的代码块，包括最开始的简短模式，都必须有真实的错误分支退出或 else 隔离。if (!tmp) { /*处理失败*/ } a = tmp; 仍然错误：注释不改变控制流，失败后会继续覆盖。必须真实写 return/goto/else，不能只在后面的完整示例里修正。
- 对本题main拥有旧块的示例，失败分支可真实写 free(p); return EXIT_FAILURE; 。讲解结尾只用自然语言总结，不再输出省略错误处理的“核心模板”。
- 非零请求失败返回空指针时旧对象保持；成功后使用返回指针，旧对象生命周期已结束，即使返回地址数值相同也不能继续使用旧指针或拿它做比较。不能声称直到 a=tmp 才结束旧对象生命周期。
- 新增区域未初始化，先写后读；不能把读未初始化 int 教成可靠地得到某个随机值。字节数用 sizeof(int)，若举12字节等数字，明确假设 sizeof(int)==4。
- 复杂度区分常见分配器的直觉与标准保证，不声称标准承诺原地O(1)或失败没有内部操作，不凭空给出调试工具报告。
依据：WG14 C17问题0400及C23草案的realloc条款。公开参考：https://www.open-std.org/jtc1/sc22/wg14/issues/c11c17/log.html#issue0400 ，https://www.open-std.org/jtc1/sc22/wg14/www/docs/n3096.pdf 。这是给定依据；若本轮没有调用联网工具，不得声称刚刚联网核查。`;
}
