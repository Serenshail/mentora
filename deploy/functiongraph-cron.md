# FunctionGraph 定时触发器：周报（T-040，HW-D-07）

## 目标与原则

用华为云 FunctionGraph 定时触发器替代 Vercel Cron 作为华为云部署的周报入口；**应用侧零改动**（端点、鉴权、opt-in 纪律全部不变）。`vercel.json` 的 crons 保留，Vercel 旧入口继续可用（双载体不劣化）。

- 端点：`POST/GET https://<DEMO_URL>/api/cron/weekly-digest`
- 鉴权：请求头 `Authorization: Bearer $CRON_SECRET`，服务端 fail-closed——未配置或比对失败一律 403（src/app/api/cron/weekly-digest/route.ts:36-39）
- 时刻：北京每周一 09:00（= UTC 周一 01:00，与 vercel.json `0 1 * * 1` 等价）

## 前置

- `CRON_SECRET` 已通过编排注入容器（CCE：mentora-secrets；ECS：.env.hw）。**绝不写入任何仓库文件或函数代码。**
- `DEMO_URL` 为已可公网访问的部署地址（T-035 完成后）。

## 创建步骤（控制台）

1. FunctionGraph → 创建函数：
   - 运行时：Node.js 20（或 Python 3.10）；内存 128MB / 超时 60s 足够（仅发一次 HTTP 调用）
   - 环境变量（在函数配置中设置，不写进代码）：`DEMO_URL`、`CRON_SECRET`
2. 函数代码（index.js，无第三方依赖）：

   ```js
   export const handler = async () => {
     const url = process.env.DEMO_URL;
     const secret = process.env.CRON_SECRET;
     if (!url || !secret) return { statusCode: 500, body: "missing DEMO_URL/CRON_SECRET" };
     const r = await fetch(`${url}/api/cron/weekly-digest`, {
       method: "POST",
       headers: { Authorization: `Bearer ${secret}` },
     });
     const body = await r.text();
     return { statusCode: r.status, body: body.slice(0, 2000) };
   };
   ```

3. 创建定时触发器：
   - 类型：定时触发器（Timer）→ 自定义周期
   - 计划：每周，周一，09:00（Quartz 表达式 `0 0 9 ? * MON`；FunctionGraph 定时触发器按 UTC+8 计算，与北京周一 09:00 一致）
   - 开启"启用"
4. （可选）失败告警：函数异步调用失败事件 → SMN 通知，保证漏发可知。

## 验证（T-041，执行后留痕 docs/evidence/cron-trigger.md）

1. **带凭据手动触发**：控制台"测试事件"执行函数 → 返回 200，且仅 opt-in 用户收到周报（无事不打扰：无内容用户不收信）。
2. **无凭据拒绝**：直接 `curl -X POST https://<DEMO_URL>/api/cron/weekly-digest`（无 Authorization 头）→ 403。
3. **无发信配置场景**：RESEND_API_KEY 置空时触发 → 端点如实报错、不误发（既有纪律，见 spec §发信）。

三条场景通过后，把请求/响应摘要（脱敏，不含 CRON_SECRET）归档 `docs/evidence/cron-trigger.md`。