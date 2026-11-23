/** gen-plugin-shared.mjs 的模块解析钩子：让 TS 无扩展名相对导入（"./types"）在
 *  Node strip-types 下可解析。只补 .ts 后缀，失败回落原生解析。 */
export async function resolve(specifier, context, next) {
  if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
    try {
      return await next(specifier + ".ts", context);
    } catch { /* 目标确实不带 .ts 时走原路径 */ }
  }
  return next(specifier, context);
}
