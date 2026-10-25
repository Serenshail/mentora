import { describe, expect, it, vi } from "vitest";

/* url-guard.ts 是服务端模块（import "server-only"），在 vitest 里需要豁免该护栏（同 ai-config.test.ts） */
vi.mock("server-only", () => ({}));

import { checkUrlShape } from "../server/url-guard";

/* 只测形态层（不发起 DNS）。私有网段判定在形态层就对字面 IP 生效，
 * 这组用例是 2026-10-24 IPv6 展开写法旁路的回归锁：
 * 旧实现只字符串比对 "::1"，"0:0:0:0:0:0:0:1"（net.isIP 认它是 IPv6）直接放行。 */
describe("checkUrlShape（出网 URL 形态守卫）", () => {
  it("正常公网 https 放行", () => {
    expect(checkUrlShape("https://example.com/docs", { allowHttp: false })).not.toBeNull();
  });

  it("回环地址全写法一律拒绝", () => {
    expect(checkUrlShape("http://[::1]/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://[0:0:0:0:0:0:0:1]/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://[::ffff:127.0.0.1]/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://127.0.0.1/", { allowHttp: true })).toBeNull();
  });

  it("内网/保留段 IPv4 拒绝", () => {
    expect(checkUrlShape("http://10.0.0.1/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://192.168.1.1/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://169.254.169.254/latest/meta-data/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://100.64.0.1/", { allowHttp: true })).toBeNull();
  });

  it("IPv6 ULA/link-local/组播/文档段拒绝", () => {
    expect(checkUrlShape("http://[fd00::1]/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://[fe80::1]/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://[ff02::1]/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://[2001:db8::1]/", { allowHttp: true })).toBeNull();
  });

  it("协议/端口/userinfo 约束", () => {
    expect(checkUrlShape("http://example.com/", { allowHttp: false })).toBeNull();
    expect(checkUrlShape("ftp://example.com/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("https://user:pass@example.com/", { allowHttp: false })).toBeNull();
    expect(checkUrlShape("https://example.com:8080/", { allowHttp: false })).toBeNull();
    expect(checkUrlShape("https://localhost/", { allowHttp: false })).toBeNull();
  });
});
