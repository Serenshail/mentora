import { describe, expect, it } from "vitest";
import { extractJson } from "../ai/client";

describe("extractJson（容忍围栏/前后缀）", () => {
  it("解析 ```json 围栏", () => {
    const t = '好的。\n```json\n{"a":1,"b":[2,3]}\n```\n以上。';
    expect(extractJson<{ a: number }>(t).a).toBe(1);
  });
  it("解析裸 JSON（无围栏）", () => {
    expect(extractJson<{ ok: boolean }>('{"ok":true}').ok).toBe(true);
  });
  it("解析带前缀叙述的 JSON", () => {
    const t = '结论如下：{"verdict":"pass","summary":"x"} 希望有帮助。';
    expect(extractJson<{ verdict: string }>(t).verdict).toBe("pass");
  });
  it("字符串内含括号不误配", () => {
    const t = '{"s":"a } b { c","n":2}';
    expect(extractJson<{ n: number }>(t).n).toBe(2);
  });
  it("无 JSON 时抛错", () => {
    expect(() => extractJson("纯文本,没有 json")).toThrow();
  });
});
