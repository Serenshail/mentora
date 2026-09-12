import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * 用户反馈后端：直接写入 GitHub Issues。
 * 部署者在仓库 Issues 里即可看到全部反馈，可回复、可关单。
 * env: GITHUB_TOKEN（需 repo 权限）、GITHUB_REPO（默认 haow9508-ctrl/mentora）
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const content = String(body?.content ?? "").trim();
  const type = ["建议", "问题", "其他"].includes(body?.type) ? body.type : "其他";
  const contact = String(body?.contact ?? "").trim();
  const page = String(body?.page ?? "").slice(0, 120);

  if (content.length < 2) {
    return Response.json({ error: "反馈内容太短了" }, { status: 400 });
  }
  if (content.length > 4000) {
    return Response.json({ error: "反馈太长了，请精简到 4000 字以内" }, { status: 400 });
  }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || "haow9508-ctrl/mentora";
  if (!token) {
    return Response.json(
      { error: "反馈通道未配置（服务端缺少 GITHUB_TOKEN），反馈未送达" },
      { status: 503 }
    );
  }

  const ua = req.headers.get("user-agent")?.slice(0, 150) || "";
  const title = `[${type}] ${content.slice(0, 50)}${content.length > 50 ? "…" : ""}`;
  const meta = [
    "---",
    `来源页面：${page || "未知"}`,
    `时间：${new Date().toISOString()}`,
    contact ? `联系方式：${contact}` : "联系方式：未留",
    ua ? `环境：${ua}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        title,
        body: `${content}\n\n${meta}`,
        labels: ["user-feedback"],
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return Response.json(
        { error: `反馈提交失败（${res.status}）` , detail: t.slice(0, 200) },
        { status: 502 }
      );
    }
    const issue = await res.json();
    return Response.json({ ok: true, url: issue.html_url, number: issue.number });
  } catch {
    return Response.json({ error: "网络错误，反馈未送达" }, { status: 502 });
  }
}
