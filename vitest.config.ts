import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// 仅补 @/* 别名解析（tsconfig paths），让 App Router 路由文件可以直接被单测导入。
// 不设置 include/exclude：沿用 vitest 默认（**/*.{test,spec}.?(c|m)[jt]s?(x)），
// e2e 仍由 package.json 的 "vitest run e2e" 过滤。
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // server-only 的默认入口会 throw；单测改用官方空模块，让服务端模块可被导入
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
});
