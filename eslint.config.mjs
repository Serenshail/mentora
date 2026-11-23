import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // 小程序与脚本是 ES5 风格 CommonJS（var/function、require()、var that = this），
  // 是既定风格不是欠账：按组放行这两类规则，别让 100+ 条风格 error 淹没 src/ 的真错误。
  // no-unused-vars 维持警告不动，仍可看到死代码信号。
  {
    files: ["miniprogram/**/*.js", "scripts/**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-this-alias": "off",
    },
  },
  // 测试文件里为模拟小程序 Page/Store 等外部对象需要宽松夹具类型，
  // any 是测试脚手架的既定做法（同 miniprogram 组），不在生产代码范围内。
  // 生产代码的 any 仍然报错。
  {
    files: ["src/lib/__tests__/**/*.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
]);

export default eslintConfig;
