<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 用户验收交付约定

每次完成修改，必须打开可访问的预览与简短验收清单，写清操作和预期结果，由用户最终验收。区分本地、已发布线上、受控测试样例及尚未验证项目；不能把自动化检查通过等同用户验收通过。

## 当前交付环境

用户实际验收地址为 http://192.144.181.171（腾讯云）。网站修改须明确是否已发布至该地址，并核对公网构建标识后交验；本地预览不得当作线上交付。当前主服务 mentora.service，新发布目录及回退记录见 docs/evidence/tencent-release-2026-11-17/ACCEPTANCE.md。数据库迁移不包含在普通页面更新内。
