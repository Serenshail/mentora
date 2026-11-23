import { describe,it,expect,beforeEach } from "vitest";
import { parseWikiTarget,mapWikiLinks,buildWikiIndex,resolvedWikiIds,wikiHeadingId,hasUnlinkedWikiMention,withResolvedWikiLinks } from "../wiki-links";
import { useAppStore } from "../store";
import type { KnowledgeItem } from "../types";

describe("Obsidian 内链语义",()=>{
  it("区分路径、md后缀、章节与显示别名",()=>{
    expect(parseWikiTarget("文件夹/笔记.md#使用方法|一个例子")).toEqual({title:"文件夹/笔记",heading:"使用方法",label:"一个例子"});
  });
  it("代码围栏、行内代码、转义示例不转换成链接",()=>{
    const body="[[甲]] `[[乙]]`\n```md\n[[乙]]\n```\n~~~\n[[乙]]\n~~~\n\\[[乙]]";
    expect(mapWikiLinks(body,raw=>`LINK:${raw}`)).toBe("LINK:甲 `[[乙]]`\n```md\n[[乙]]\n```\n~~~\n[[乙]]\n~~~\n\\[[乙]]");
  });
  it("路径链接与别名链接能解析为稳定id",()=>{
    const index=buildWikiIndex([{id:"a",title:"甲",domain:"文件夹"},{id:"b",title:"乙"}]);
    expect(resolvedWikiIds("[[文件夹/甲.md#说明|别名]] `[[乙]]`",index)).toEqual(["a"]);
  });
  it("重复标题不任意选中最后一篇",()=>{
    const index=buildWikiIndex([{id:"a",title:"甲"},{id:"b",title:"甲"},{id:"c",title:"甲"}]);
    expect(index.get("甲")).toBeNull();
  });
  it("Markdown格式标题与可见标题定位一致",()=>expect(wikiHeadingId("**用法**")).toBe(wikiHeadingId("用法")));
  it("图谱从正文补全关系并过滤失效、自身和重复连接",()=>{
    const notes=[{id:"a",title:"甲",body:"[[乙|别名]]",links:["a","missing","b"]},{id:"b",title:"乙",body:"",links:[]}];
    expect(withResolvedWikiLinks(notes)[0].links).toEqual(["b"]);
    expect(notes[0].links).toEqual(["a","missing","b"]);
  });
  it("未链接提及只包含普通文字，不包含已经链接的文字和代码示例",()=>{
    expect(hasUnlinkedWikiMention("可以试试 甲 的方法","甲")).toBe(true);
    expect(hasUnlinkedWikiMention("[[甲|别名]] `甲`\n```md\n甲\n```","甲")).toBe(false);
  });
});

const note=(id:string,title:string,body:string,links:string[]=[]):KnowledgeItem=>({id,title,body,links,domain:"笔记",source:"manual",sourceTitle:"",masteredAt:"2026-11-17",reviewStage:0,version:1});
describe("笔记链接随编辑与重命名保持一致",()=>{
  beforeEach(()=>useAppStore.setState({knowledge:[note("a","甲","# 用法"),note("b","乙","见 [[甲#用法|别名]] 和 `[[甲]]`",["a"])]}));
  it("重命名同步真实引用，保留章节、别名和代码原文",()=>{
    useAppStore.getState().updateKnowledge("a",{title:"新标题"});
    const b=useAppStore.getState().knowledge.find(n=>n.id==="b")!;
    expect(b.body).toBe("见 [[新标题#用法|别名]] 和 `[[甲]]`");
    expect(b.links).toContain("a");expect(b.version).toBe(2);
  });
  it("删去正文链接后移除反链，手动链接保留",()=>{
    useAppStore.getState().updateKnowledge("b",{links:["a","manual-id"],body:"不再引用"});
    expect(useAppStore.getState().knowledge.find(n=>n.id==="b")!.links).toEqual(["manual-id"]);
  });
});
