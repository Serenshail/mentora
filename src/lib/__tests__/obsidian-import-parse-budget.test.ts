import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseVault, PARSE_MAX_BYTES, PARSE_MAX_FILES } from "@/lib/obsidian-import";

/* ============ Obsidian 导入：parseVault 必须有篇数/总字节预算（回归锁） ============
 * 背景（已由独立复核读码证实）：
 *   单文件有 512KB 上限（obsidian-import.ts 里的 `file.size > 512 * 1024`），但篇数与
 *   总字节数无上限。按目录勾选与「仅结构」降级都发生在 parseVault 完成之后，而解析会把
 *   每个 .md 的正文 file.text() 读进 ParsedNote 常驻内存（out + setParsed 的 React state）。
 *   移动端选一个几万篇的库，会在拿到任何降级选项前先把数百 MB 字符串拉进内存，崩标签页。
 *
 * 修复：解析阶段自带总预算（PARSE_MAX_FILES / PARSE_MAX_BYTES），在读取之前判定，
 *   超出即停止读文件并把未解析篇数作为 truncated 返回；调用方据此提示分批导入。
 *
 * 用假的 File 对象（只实现 name/size/text）来精确统计 text() 被调用次数——
 * 这是「未超预算的文件绝不被读进内存」的直接证据。 */

interface FakeFile {
  name: string;
  size: number;
  text: () => Promise<string>;
}

function makeFiles(n: number, opts: { size?: number; body?: string } = {}) {
  const reads: string[] = [];
  const size = opts.size ?? 100;
  const files: FakeFile[] = [];
  for (let i = 0; i < n; i++) {
    const name = `note-${i}.md`;
    files.push({
      name,
      size,
      text: async () => {
        reads.push(name);
        return opts.body ?? `# ${name}\n\nbody`;
      },
    });
  }
  return { files: files as unknown as File[], reads };
}

describe("parseVault：超大库必须在读取阶段截断，而不是全量驻留内存", () => {
  it("未超预算：全部解析，truncated=0，每个文件只读一次", async () => {
    const { files, reads } = makeFiles(5);
    const { notes, truncated } = await parseVault(files);
    expect(notes).toHaveLength(5);
    expect(truncated).toBe(0);
    expect(reads).toHaveLength(5);
    expect(notes.every((n) => n.skipped === null)).toBe(true);
  });

  it("篇数预算：超过 maxFiles 后不再读取任何文件，truncated 报告剩余篇数", async () => {
    const { files, reads } = makeFiles(10);
    const { notes, truncated } = await parseVault(files, undefined, { maxFiles: 3 });
    expect(notes).toHaveLength(3);
    expect(truncated).toBe(7);
    // 关键断言：只有预算内的 3 篇被 text() 读进内存
    expect(reads).toEqual(["note-0.md", "note-1.md", "note-2.md"]);
  });

  it("字节预算：累计已读字节触顶后停止读取（预算在读取前判定）", async () => {
    const { files, reads } = makeFiles(10, { size: 10 });
    const { notes, truncated } = await parseVault(files, undefined, { maxBytes: 25 });
    // 0→10→20 都 < 25，读完第 3 篇后 bytes=30 ≥ 25，第 4 篇起不再读
    expect(reads).toHaveLength(3);
    expect(notes).toHaveLength(3);
    expect(truncated).toBe(7);
  });

  it("被跳过的文件不消耗字节预算（不读正文），但仍计入篇数预算", async () => {
    const { files, reads } = makeFiles(4, { size: 1000 });
    // 把前两篇伪装成模板目录（relativePath 落在 templates/ 下）
    for (const f of files.slice(0, 2)) {
      (f as unknown as { webkitRelativePath: string }).webkitRelativePath = "vault/templates/t.md";
    }
    const { notes, truncated } = await parseVault(files, undefined, { maxBytes: 1500 });
    expect(notes.slice(0, 2).every((n) => n.skipped === "系统/模板目录")).toBe(true);
    // 只有后面 2 篇真正读了；1000+1000=2000 ≥ 1500，第 4 篇仍会被读（读取前 bytes=1000<1500）
    expect(reads).toHaveLength(2);
    expect(notes).toHaveLength(4);
    expect(truncated).toBe(0);
  });

  it("默认预算存在且为正数（防止常量被误改成 Infinity/0）", () => {
    expect(PARSE_MAX_FILES).toBeGreaterThan(0);
    expect(PARSE_MAX_BYTES).toBeGreaterThan(0);
    expect(Number.isFinite(PARSE_MAX_FILES)).toBe(true);
    expect(Number.isFinite(PARSE_MAX_BYTES)).toBe(true);
  });

  it("调用方必须消费 truncated 并提示用户（返回类型从数组改成对象后不能静默忽略）", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/brain/obsidian-import.tsx"),
      "utf8"
    );
    expect(src).toMatch(/const\s*\{\s*notes\s*,\s*truncated\s*\}\s*=\s*await\s+parseVault\(/);
    expect(src).toMatch(/truncated\s*>\s*0/);
    expect(src).toContain("分批");
  });
});
