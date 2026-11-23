import { describe, expect, it, vi } from "vitest";

/* url-guard.ts 是服务端模块（import "server-only"），在 vitest 里需要豁免该护栏（同 url-guard.test.ts） */
vi.mock("server-only", () => ({}));

import { checkUrlShape } from "../server/url-guard";

/* 2026-11-10 回归锁：私网黑名单漏段。
 * 旧实现 isPrivateV4 未覆盖 198.18.0.0/15（VPN/TUN fake-IP 常用基准段）与
 * TEST-NET-2/3；isPrivateV6 只处理 ::ffff: / ::x.y 内嵌 IPv4，漏掉 6to4
 * (2002::/16)、NAT64 (64:ff9b::/96)、Teredo (2001:0::/32) 三类同样把 IPv4
 * 藏进 IPv6 字面量的形态——这些字面量在形态层会被直接放行。 */
describe("checkUrlShape 私网黑名单（IPv4 保留段 + 内嵌 IPv4 的 IPv6 形态）", () => {
  it("198.18.0.0/15（VPN/TUN fake-IP 基准段）拒绝", () => {
    expect(checkUrlShape("http://198.18.0.1/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://198.19.255.254/", { allowHttp: true })).toBeNull();
  });

  it("TEST-NET-2/3 文档段拒绝", () => {
    expect(checkUrlShape("http://198.51.100.1/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://203.0.113.9/", { allowHttp: true })).toBeNull();
  });

  it("6to4 2002::/16 内嵌私网 IPv4 拒绝", () => {
    expect(checkUrlShape("http://[2002:7f00:0001::]/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://[2002:0a00:0001::]/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://[2002:c0a8:0101::]/", { allowHttp: true })).toBeNull();
  });

  it("NAT64 64:ff9b::/96 内嵌私网 IPv4 拒绝，本地专用 64:ff9b:1::/48 整体拒绝", () => {
    expect(checkUrlShape("http://[64:ff9b::7f00:1]/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://[64:ff9b::192.168.1.1]/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://[64:ff9b:1::1]/", { allowHttp: true })).toBeNull();
  });

  it("Teredo 2001:0::/32 整体拒绝", () => {
    expect(checkUrlShape("http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://[2001:0000::1]/", { allowHttp: true })).toBeNull();
  });

  it("公网地址不被误杀（回归正向）", () => {
    expect(checkUrlShape("https://8.8.8.8/", { allowHttp: false })).not.toBeNull();
    expect(checkUrlShape("https://198.17.0.1/", { allowHttp: false })).not.toBeNull();
    expect(checkUrlShape("https://[2002:0808:0808::]/", { allowHttp: false })).not.toBeNull(); // 6to4 内嵌 8.8.8.8
    expect(checkUrlShape("https://[64:ff9b::808:808]/", { allowHttp: false })).not.toBeNull(); // NAT64 内嵌 8.8.8.8
    expect(checkUrlShape("https://[2606:4700:4700::1111]/", { allowHttp: false })).not.toBeNull();
  });

  it("既有回环/映射写法仍拒绝（不回归）", () => {
    expect(checkUrlShape("http://[::1]/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://[::ffff:127.0.0.1]/", { allowHttp: true })).toBeNull();
    expect(checkUrlShape("http://[0:0:0:0:0:0:0:1]/", { allowHttp: true })).toBeNull();
  });
});
