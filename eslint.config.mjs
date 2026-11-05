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
]);

export default eslintConfig;
