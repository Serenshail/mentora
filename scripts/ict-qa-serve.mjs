#!/usr/bin/env node
/* 以 .env.qa 启动候选版（3101），不加载生产 D1 配置 */
import fs from "node:fs";
import { spawn } from "node:child_process";

const parse = (file) =>
  Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      })
  );

const env = { ...process.env, ...parse(".env.qa") };
delete env.CLOUDFLARE_ACCOUNT_ID;
delete env.CLOUDFLARE_D1_DATABASE_ID;
delete env.CLOUDFLARE_D1_API_TOKEN;

const child = spawn("npm", ["start", "--", "-p", "3101"], {
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 0));