/** Shared wikilink syntax for rendering and deriving note relationships. */
export function parseWikiTarget(raw: string) {
  const [destination, ...labels] = raw.split("|");
  const [path, ...sections] = destination.trim().split("#");
  const title = path.trim().replace(/\.md$/i, "");
  const heading = sections.join("#").trim();
  return { title, heading, label: labels.join("|").trim() || title.split("/").pop() || heading };
}

export function mapWikiLinks(body: string, replace: (raw: string) => string): string {
  let fence: { char: string; length: number } | null = null;
  return body.split("\n").map(line => {
    const mark = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (mark) {
      if (!fence) fence = { char: mark[1][0], length: mark[1].length };
      else if (mark[1][0] === fence.char && mark[1].length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;
    return line.replace(/(`+).*?\1|\\\[\[[^\n]*?\]\]|\[\[([^\[\]\n]+)\]\]/g,
      (match, _code, raw: string | undefined) => raw === undefined ? match : replace(raw));
  }).join("\n");
}

export function buildWikiIndex<T extends { id: string; title: string; domain?: string }>(notes: T[]) {
  const index = new Map<string, T | null>();
  for (const note of notes) {
    for (const key of [note.title, ...(note.domain ? [`${note.domain}/${note.title}`] : [])]) {
      const normalized = key.trim().toLowerCase();
      const previous = index.get(normalized);
      index.set(normalized, index.has(normalized) && previous?.id !== note.id ? null : note);
    }
  }
  return index;
}

export function wikiHeadingId(text: string) {
  const plain = text.replace(/\[([^\]]+)\]\([^)]*\)/g,"$1").replace(/[`*_]/g,"");
  return `wiki-heading-${encodeURIComponent(plain.trim().replace(/\s+/g, " ").toLowerCase())}`;
}

export function resolvedWikiIds(body: string, index: Map<string, { id: string } | null>): string[] {
  const ids = new Set<string>();
  mapWikiLinks(body, raw => {
    const target = index.get(parseWikiTarget(raw).title.toLowerCase());
    if (target) ids.add(target.id);
    return raw;
  });
  return [...ids];
}

/** Merge imported/body links with explicit manual relationships without writing the store. */
export function withResolvedWikiLinks<T extends { id: string; title: string; domain?: string; body: string; links: string[] }>(notes: T[]): T[] {
  const index = buildWikiIndex(notes);
  const ids = new Set(notes.map(note => note.id));
  return notes.map(note => ({ ...note, links: [...new Set([...note.links, ...resolvedWikiIds(note.body,index)])].filter(id=>id!==note.id&&ids.has(id)) }));
}

/** Plain-text mentions exclude wikilinks, inline code and fenced code examples. */
export function hasUnlinkedWikiMention(body: string, title: string): boolean {
  let fence: { char: string; length: number } | null = null;
  const text = mapWikiLinks(body,()=>"").split("\n").map(line=>{
    const mark=line.match(/^ {0,3}(`{3,}|~{3,})/);
    if(mark){
      if(!fence)fence={char:mark[1][0],length:mark[1].length};
      else if(mark[1][0]===fence.char&&mark[1].length>=fence.length)fence=null;
      return "";
    }
    return fence ? "" : line.replace(/(`+).*?\1/g,"");
  }).join("\n").toLowerCase();
  return !!title.trim() && text.includes(title.trim().toLowerCase());
}
