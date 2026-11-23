/* 智能体事件与工具协议（v2，通用 harness）
 *
 * 参照 openai/codex（MIT）codex-rs/protocol/src/items.rs 的模型：
 *   TurnItem = UserMessage | AgentMessage | Plan | Reasoning | CommandExecution | McpToolCall
 *   PlanItem     = { id, text }                      —— 计划是一条条 item
 *   ReasoningItem= { id, summaryText[], rawContent[] } —— 对外只给摘要
 *   Tool 状态    = InProgress | Completed | Failed | Declined
 *
 * v2 纪律：
 *  1. 只读工具自动执行；写入工具必须经用户确认（PendingAction 审批门）；
 *  2. 计划外显，每步状态可见；
 *  3. 工具失败如实标 failed，回答继续；
 *  4. 单轮最多 MAX_TOOL_ROUNDS 轮；同一「工具+参数」连续重复视为打转，强制收尾；
 *  5. 涉密参数（apiKey/baseUrl/密码/账号操作）不进注册表——模型无法调用不存在的东西。
 */

export type ToolStatus = "in_progress" | "completed" | "failed" | "declined";

export type ToolName =
  | "manage_workspace"
  | "manage_goal"
  /* ---- 检索与读取（只读） ---- */
  /** 检索第二大脑笔记（只读） */
  | "search_brain"
  /** 读取当前学习/阅读/会话状态总览（只读） */
  | "read_context"
  /** 按 id 或标题读取笔记全文（只读） */
  | "get_note"
  /** 列出学习目标（只读） */
  | "list_goals"
  /** 读取某个目标详情（只读） */
  | "get_goal"
  /** 列出书架（只读） */
  | "list_books"
  /** 列出人生伙伴会话（只读） */
  | "list_sessions"
  /** 读取公开设置（只读；绝不含 apiKey/baseUrl 值） */
  | "get_settings_public"
  /** 出题检验（只读，不含判分） */
  | "make_quiz"
  /* ---- 联网（只读，服务端守卫） ---- */
  /** 联网搜索（/api/search） */
  | "web_search"
  /** 读取一个公网页面的正文（/api/fetch-page） */
  | "read_url"
  /* ---- 写入（必须用户确认） ---- */
  /** 新建笔记 */
  | "save_note"
  /** 修改已有笔记（按 id 或标题） */
  | "update_note"
  /** 删除笔记 */
  | "delete_note"
  /** 新建学习目标草稿（完整计划在学习页生成） */
  | "create_goal"
  /** 新建书（自动拆阅读章节） */
  | "add_book"
  /** 新建人生伙伴会话 */
  | "create_session"
  /** 修改白名单设置（userName/coachTone/digestWeekly；provider/model 需确认） */
  | "update_settings"
  /** 恢复已有工作流：查学习目标/书架/会话的现有进度，返回接续入口（只读） */
  | "resume_workflow"
  /** 按硬约束重出某阶段的视频学习资源（写入，需确认） */
  | "update_plan_resources"
  /** 重排某阶段的天级目录（写入，需确认；完成日>0 时审批卡带警告） */
  | "regenerate_phase"
  /** 讨论后精确修改学习计划（阶段标题/目标/顺序/增删/天目录/边界）。方案先预览、批准后应用（写入，需确认） */
  | "edit_phase"
  /* ---- 第二批 C（AG-05）：阅读与笔记业务动作 ---- */
  /** 读取指定书的详细状态：目标/路线/章节进度/沉淀（只读；带 chapterTitle 时返回章节详情供讨论与检验） */
  | "get_book"
  /** 记录节点验收结果（检验理解）。level 与判分依据（evidence）必填。写入，需确认 */
  | "record_book_assessment"
  /** 修改书目信息（书名/作者）。写入，需确认 */
  | "update_book"
  /** 删除书籍（影响范围先展示）。写入，需确认 */
  | "remove_book"
  /** 重排阅读路线（完整/核心/目标导向）。方案先预览、批准后应用；旧路线存历史可恢复。写入，需确认 */
  | "rebuild_reading_route"
  /** 恢复到某次阅读路线历史版本。写入，需确认 */
  | "restore_book_route"
  /** 修改阅读目标（主/次目标、为什么读、当前基础）。写入，需确认 */
  | "edit_book_goal"
  /** 设置阅读进度：章节状态与全书状态。写入，需确认 */
  | "set_reading_progress"
  /** 调整阅读路线节点顺序（上移/下移一位）。写入，需确认 */
  | "move_chapter"
  /** 保存阅读沉淀（带章节来源）。写入，需确认 */
  | "save_reading_deposit"
  /** 建立两条笔记之间的双链关联。写入，需确认 */
  | "link_notes"
  /** 复习队列：list 查看待复习；enable 加入/移出队列（写）；record 提交复习表现（写） */
  | "review_queue"
  /* ---- 批次 D（AG-06）：人生伙伴与圆桌 ---- */
  /** 读取指定人生伙伴会话的详情（人物/议题/最近消息）。只读 */
  | "get_session"
  /** 重命名或删除人生伙伴会话。写入，需确认 */
  | "manage_session"
  /** 塑造自定义人物（蒸馏身份供用户核对后入库）。写入，需确认 */
  | "forge_persona"
  /** 发起/继续讨论（单人或圆桌）：定位会话、带入议题与新约束，真实执行并写回原会话。写入，需确认 */
  | "run_discussion"
  /** 调整圆桌与会阵容（下一轮生效，历史发言保留）。写入，需确认 */
  | "set_participants"
  /* ---- 个人扩展（v24.0 二期，action 型；读自动、写需确认） ---- */
  /** 长期记忆：recall / remember / forget */
  | "memory"
  /** 定时提醒：list / create / delete */
  | "reminders";

export interface ToolSpec {
  name: ToolName;
  label: string;
  /** 只读工具自动执行；写入必须用户确认。注意这是**整工具**的默认档位。 */
  risk: "read" | "write";
  /** risk:"read" 但含写入动作的混合工具：列出需要审批的 action 值。
   *  为什么不能直接把 risk 标成 "write"：executeTool 靠 risk 把 memory/reminders/review_queue
   *  分发到 runPersonalTool / 复习队列分支（内部再按 action 走 draftAction 审批门），
   *  标成 write 会被分发给 validateWriteTool →「未知写入工具」，工具直接坏掉。
   *  消费方（runner 的写轮次判定、服务端工具提示词）读这个字段把它当写动作处理，
   *  避免各处再手抄一份「哪些 action 是写」的名单。 */
  writeActions?: string[];
  description: string;
  /** 给模型看的参数说明（一句话） */
  params: string;
}

/** 一次调用是否含写入语义：整体 write 工具恒真；混合工具看具体 action。
 *  runner 的 V26.2 收口据此判断「写入轮次的过渡语一律不并入最终回答」——
 *  写动作（memory/remember、reminders/create 等）此前因整工具标 read 而漏判，
 *  超过 60 字的内部交代语会被并进最终消息给用户看到。 */
export function isWriteCall(name: ToolName, args: Record<string, unknown>): boolean {
  const spec = TOOLS[name];
  if (!spec) return false;
  if (spec.risk === "write") return true;
  const action = typeof args.action === "string" ? args.action : "";
  return Boolean(action && spec.writeActions?.includes(action));
}

export const TOOLS: Record<ToolName, ToolSpec> = {
  manage_goal:{name:"manage_goal",label:"调整学习目标",risk:"write",description:"修改已有学习目标的名字、方向、背景、每周时间、暂停/继续，或删除目标并保留笔记。必须先读取目标的准确 id，同名不得猜第一项；阶段与学习日修改用 edit_phase。此工具不能伪造验收或完成成绩。",params:"action:update|delete, id:string（准确目标id）, patch?:{topic?:string,direction?:string,motivation?:string,background?:string,weeklyHours?:number,status?:active|paused}"},
  manage_workspace: {
    name:"manage_workspace",label:"搭建我的系统",risk:"read",writeActions:["create","update","delete"],
    description:"按用户当前学习需要搭建或调整个人页面，并固定到侧栏。list/read 读取，create/update/delete 写入。页面可组合文档 markdown、可勾选清单 checklist、自定义可编辑表格 table、实时计划 goals、笔记 notes、书架 books。不是预装模板；先理解需求，再组合必要内容。不支持执行任意脚本、安装插件或更改设置。修改前 read；更新用 upsertBlocks 保留其他块；遇到未支持的能力须如实说明。",
    params:"action: list|read|create|update|delete, id?:页面id, blockId?:读取单块, title?:页面名, description?:用途, pinned?:是否固定侧栏, blocks?:完整内容块[], upsertBlocks?:要新增或替换的内容块[], removeBlockIds?:要删除的块id[], query?:检索, offset?:分页。块必有 id/type/title；markdown:text；checklist:items[{id,text,done}]；table:columns[{id,label}],rows[{id,cells:{列id:值}}]；goals/notes/books:ids?:对象id[],query?:关键词。"
  },
  search_brain: {
    name: "search_brain",
    label: "检索笔记",
    risk: "read",
    description: "在用户第二大脑里检索相关笔记，返回标题与关键摘录。",
    params: "query: string（检索词，2-30 字）",
  },
  read_context: {
    name: "read_context",
    label: "查看我的状态",
    risk: "read",
    description: "读取当前学习目标、今日任务、待复习数、正在读的书、最近会话一览。",
    params: "（无参数）",
  },
  get_note: {
    name: "get_note",
    label: "读笔记全文",
    risk: "read",
    description: "按标题或 id 读取一篇笔记的完整内容。",
    params: "title?: string, id?: string（二选一）",
  },
  list_goals: {
    name: "list_goals",
    label: "列出学习目标",
    risk: "read",
    description: "实时列出所有状态的学习目标：稳定id、方向、创建时间、进度和阶段。可按关键词与状态筛选、分页；total 是匹配总数，nextOffset 非空须继续读取，不能把当前页数当总数。名称相同不表示同一个目标。",
    params: "query?: string（主题或方向，大小写不敏感）, status?: draft|active|paused|done, offset?: number（从0开始）, limit?: number（默认25，最大50）",
  },
  get_goal: {
    name: "get_goal",
    label: "看目标详情",
    risk: "read",
    description: "按主题关键词或精确 id 读取某个学习目标的计划与当前进度，并列出每个阶段的**序号与稳定 phaseId**（改计划前必须先读这里，用里面的 id；不要自己编 id）。名称相近时返回候选列表请用户选择。",
    params: "topic?: string（主题关键词）, id?: string（精确目标 id，对话框里已明确对象时优先用）",
  },
  list_books: {
    name: "list_books",
    label: "看书架",
    risk: "read",
    description: "列出书架上的书与阅读状态。",
    params: "（无参数）",
  },
  list_sessions: {
    name: "list_sessions",
    label: "列出会话",
    risk: "read",
    description: "列出人生伙伴的会话（含圆桌）。",
    params: "（无参数）",
  },
  get_settings_public: {
    name: "get_settings_public",
    label: "查看设置",
    risk: "read",
    description: "读取当前设置（模型选择、称呼、教练风格、周报开关）。不含 API Key 等敏感值。",
    params: "（无参数）",
  },
  make_quiz: {
    name: "make_quiz",
    label: "出题检验",
    risk: "read",
    description: "针对刚讲过的内容出 2-5 道小题（不含答案），帮助用户自检。按 topic 或 goalId/dayId 精确定位到指定目标与学习日，题目针对该日知识点生成（AQ-03）。",
    params: "topic?: string（目标主题）, count?: number, goalId?: string（精确目标 id）, dayId?: string（精确学习日 id）",
  },
  web_search: {
    name: "web_search",
    label: "联网搜索",
    risk: "read",
    description: "联网搜索公开网页，返回标题、链接与摘要。回答时注明来源。",
    params: "query: string（搜索词，可用用户语言）",
  },
  read_url: {
    name: "read_url",
    label: "读网页正文",
    risk: "read",
    description: "读取一个公网 URL 的正文文本（搜索结果里挑值得细读的用）。",
    params: "url: string（http/https 公网地址）",
  },
  save_note: {
    name: "save_note",
    label: "存为新笔记",
    risk: "write",
    description: "把一段内容整理成新笔记存入第二大脑。必须先在正文里给出草稿，由用户确认后才写入。",
    params: "title: string, body: string, domain?: string",
  },
  update_note: {
    name: "update_note",
    label: "修改笔记",
    risk: "write",
    description: "修改一篇已有笔记的标题或正文（按标题或 id 定位）。",
    params: "title?: string, id?: string, newTitle?: string, body?: string",
  },
  delete_note: {
    name: "delete_note",
    label: "删除笔记",
    risk: "write",
    description: "删除一篇笔记（按标题或 id 定位）。谨慎使用。",
    params: "title?: string, id?: string",
  },
  create_goal: {
    name: "create_goal",
    label: "新建学习目标",
    risk: "write",
    description: "创建学习目标草稿并交接给学习引导：把对话里已掌握的背景写进参数（用户不用重复讲），引导只补必要的问题。成功后返回接续入口。",
    params: "topic: string, direction?: string, motivation?: string, background?: string（对话中已知的用户背景，交接用）, successCriteria?: string[]",
  },
  add_book: {
    name: "add_book",
    label: "加书上架",
    risk: "write",
    description:
      "把一本书加入书架并自动生成阅读计划（拆章节）。耗时较长。系统会先核实书籍真实性：核实不过且没有材料时会被拒绝——届时如实告知用户，索要作者/ISBN/出版社或原文材料（material），不要坚持编造。",
    params:
      "title: string, author?: string, brief?: string, material?: string（用户粘贴的这本书原文片段/目录/笔记；提供了就基于材料生成并标注，不再要求搜索核实）",
  },
  create_session: {
    name: "create_session",
    label: "新建会话",
    risk: "write",
    description: "在人生伙伴里新建一个会话（指定人物或圆桌席位）。圆桌可用 participants 指定与会人物；opening 会作为第一条用户消息存入会话——议题与已讨论的约束不丢失（C02）。",
    params: "title: string, personaId?: string（人物 id，缺省 roundtable）, participants?: string[]（圆桌与会人物 id 列表）, opening?: string（开场议题，作为第一条消息存入）",
  },
  get_session: {
    name: "get_session",
    label: "看会话详情",
    risk: "read",
    description: "按标题或 id 读取人生伙伴会话详情：与会人物、议题（首条用户消息）、最近消息与数量。要继续某场讨论时先用它找回上下文。",
    params: "title?: string（会话名关键词）, id?: string（精确会话 id）",
  },
  manage_session: {
    name: "manage_session",
    label: "管理会话",
    risk: "write",
    description: "重命名或删除人生伙伴会话。action=rename（需 newTitle）；action=delete（审批卡先列出将删除的消息数）。需经确认卡。",
    params: 'action: "rename"|"delete", title?: string（会话名）, id?: string（会话 id）, newTitle?: string（rename 用）',
  },
  forge_persona: {
    name: "forge_persona",
    label: "塑造人物",
    risk: "write",
    description: "根据用户给的人物名与提示，蒸馏出一个自定义圆桌人物（真实或虚构人物均可，但 identityNote 必须写明这是模拟分析视角，不冒充真人对此问题的真实发言）。校验阶段就完成蒸馏并把身份摘要放进审批卡供用户核对，批准后才入库。耗时较长（需要真实生成）。",
    params: "name: string（人物名）, hint?: string（用户想从这个人身上获得什么视角）",
  },
  run_discussion: {
    name: "run_discussion",
    label: "发起讨论",
    risk: "write",
    description: "在指定会话里真实执行一轮讨论并写回原会话（不是只给链接）。单人会话由该人物回复；圆桌会话全员独立发言后出主持人纪要。focus 是本轮新增约束/追问（会与原议题、最近讨论一起发给席位）。retry=true 时只重试挂起的失败席位或主持人纪要（已完成发言不重复调用）。会话正在执行中时拒绝。耗时较长（需要真实生成）。需经确认卡。",
    params: "id?: string, title: string（会话名）, focus?: string（本轮新增约束/追问；retry 时可省）, retry?: boolean（重试挂起的失败席位/纪要）",
  },
  set_participants: {
    name: "set_participants",
    label: "调整阵容",
    risk: "write",
    description: "调整圆桌会话的与会阵容。participants 是完整的新名单（人物名或 id）；审批卡展示旧→新差异，说明自下一轮生效、历史发言保留。会话正在执行中时拒绝（不能中途换人）。",
    params: "id?: string, title: string（会话名）, participants: string[]（完整新名单，至少 2 人）",
  },
  update_settings: {
    name: "update_settings",
    label: "修改设置",
    risk: "write",
    description: "修改白名单内的设置：称呼、教练风格、周报开关、模型选择。API Key 与自定义端点不可通过此工具修改。",
    params: "userName?: string, coachTone?: \"standard\"|\"gentle\", digestWeekly?: boolean, provider?: string, model?: string",
  },
  resume_workflow: {
    name: "resume_workflow",
    label: "恢复工作流",
    risk: "read",
    description: "用户说\"继续学/接着读/我的进度\"时，查找已有的学习目标、书架或会话，返回当前进度与接续入口。恢复而不是重建。",
    params: "kind?: \"learning\"|\"reading\"|\"council\"（缺省自动识别）, title?: string（按主题/书名/会话名匹配）",
  },
  regenerate_phase: {
    name: "regenerate_phase",
    label: "重排阶段",
    risk: "write",
    description: "用户对某个学习阶段不满意时，重排该阶段的天级目录（换一批角度/主题）。只动目标阶段，其他阶段与已完成记录由 store 语义保留。需经确认卡。",
    params: "topic: string（目标主题）, id?: string（精确目标 id）, phaseTitle?: string（阶段名，缺省=当前阶段）, userNote?: string（用户为什么不满意/想怎么换）",
  },
  edit_phase: {
    name: "edit_phase",
    label: "编辑计划",
    risk: "write",
    description: "讨论后精确修改学习计划：改阶段标题/目标/预估天数、调整阶段顺序、增删阶段、重出某阶段天目录、改阶段边界。**执行顺序固定：先 get_goal 读到阶段的序号与 phaseId（changes 里的 <phaseId> 只能是它返回的值，不能自造），再调用本工具**。单阶段只改标题的明确小改动（如「把第二阶段标题改成 X」）按用户原指令直接执行一次，不弹确认卡；其它改动（多阶段、改天数、增删、重出天目录、改边界）先按编辑集算出方案草稿并展示新旧差异，用户批准后才写入。",
    params:
      'id?: string, topic: string（目标主题或精确 id）, changes: { phaseMeta?: {<phaseId>: {title?,outcome?,estDays?}}, phaseOrder?: string[], removePhaseIds?: string[], addPhases?: {title,outcome?,estDays?}[], phaseCatalogs?: {<phaseId>: {title,knowledgePoints?}[]}, boundaryChanges?: {<phaseId>: string} }',
  },
  update_plan_resources: {
    name: "update_plan_resources",
    label: "重出阶段资源",
    risk: "write",
    description:
      "按用户的资源硬约束（如只要中文视频、大陆可访问、不要文档）重新检索并替换指定阶段各天的学习资源。流程：先 web_search 检索 → 程序化校验（类型/可访问性）→ 用户确认后写回。找不到合格视频时如实说明，不用文档凑数。",
    params: "topic: string（目标主题）, id?: string（精确目标 id）, phaseTitle?: string（阶段名，缺省=当前阶段）, constraintText: string（用户原话，如\"只要中文视频，大陆能访问，不要文档\"）",
  },
  /* ---- 第二批 C（AG-05）：阅读与笔记业务动作 ---- */
  get_book: {
    name: "get_book",
    label: "看书的详情",
    risk: "read",
    description: "按书名或 id 读取指定书的详细状态：阅读目标、路线类型、各章节状态与进度、沉淀/迁移数量。带 chapterTitle 时返回该章的完整材料上下文（核心论点/本章问题/关键概念/验收锚点/已有沉淀）——讨论材料和检验理解前先读这个。名称相近时返回候选请用户选择。",
    params: "title?: string（书名关键词）, id?: string（精确书 id）, chapterTitle?: string（章节名或序号，给定时返回章节详情）",
  },
  record_book_assessment: {
    name: "record_book_assessment",
    label: "记验收结果",
    risk: "write",
    description: "记录某章节的验收结果（检验用户对本章材料的理解）。kind：explain 理解/connect 结构/apply 迁移。level：mastered/partial/not/ungradable。evidence 必填——引用用户原话或指出具体缺什么，判而不解释=无效判。level=mastered 时同时记为掌握（masteredAt）。需经确认卡。",
    params: "id?: string, title: string（书名）, chapterTitle: string（章节名或序号）, kind: \"explain\"|\"connect\"|\"apply\", question: string, answer: string（用户原话）, level: string, evidence: string（判分依据）, feedback: string",
  },
  rebuild_reading_route: {
    name: "rebuild_reading_route",
    label: "重排阅读路线",
    risk: "write",
    description: "按路线类型（full 完整/core 核心/goal 目标导向）为指定书重出一版章节路线。校验阶段就生成新路线并展示新旧对照，批准后才写入；旧路线自动存入历史（可恢复）；已完成的验收归档到验收档案，沉淀/对话/洞见保留。耗时较长（需要真实生成）。需经确认卡。",
    params: 'id?: string, title: string（书名）, routeType: "full"|"core"|"goal", userNote?: string（用户想怎么调）',
  },
  update_book: {
    name: "update_book",
    label: "修改书目",
    risk: "write",
    description: "修改书架上某本书的书名或作者（字段差异先预览）。章节、进度、验收、沉淀、对话全部保留。需经确认卡。",
    params: "id?: string, title: string（当前书名）, newTitle?: string, author?: string",
  },
  remove_book: {
    name: "remove_book",
    label: "删除书籍",
    risk: "write",
    description: "把一本书从书架删除。审批卡会先列出将影响的内容（章节进度/对话/沉淀/验收档案/迁移记录数量）；第二大脑笔记不受影响；删除随云同步、不可恢复。需经确认卡。",
    params: "id?: string, title: string（书名）",
  },
  restore_book_route: {
    name: "restore_book_route",
    label: "恢复阅读路线",
    risk: "write",
    description: "把指定书的路线恢复到某次历史版本（只回退章节列表与路线类型；对话/沉淀/洞见/学习状态/验收档案不动；恢复前先快照当前版，可再回退）。version 缺省=最近一次。需经确认卡。",
    params: "id?: string, title: string（书名）, version?: number（第几个历史版本，1=最早；缺省=最近一次）",
  },
  edit_book_goal: {
    name: "edit_book_goal",
    label: "改阅读目标",
    risk: "write",
    description: "修改指定书的阅读目标：主目标（understand 理解/think 思考/apply 应用/retain 沉淀）、次目标、为什么读、当前基础。修改后系统会提示用户可按新目标重排路线。需经确认卡。",
    params: 'id?: string, title: string（书名）, primary?: "understand"|"think"|"apply"|"retain", secondary?: string[], intent?: string（为什么读）, background?: string（当前基础）',
  },
  set_reading_progress: {
    name: "set_reading_progress",
    label: "更新阅读进度",
    risk: "write",
    description: "更新阅读进度：把某章节标记为 reading/done/skipped/todo，或设置全书状态（reading/finished 等）。注意：手动标记读完不等于验收掌握（masteredAt 只能来自验收通过）。需经确认卡。",
    params: 'id?: string, title: string（书名）, chapterTitle?: string（章节名或序号）, chapterStatus?: "reading"|"done"|"skipped"|"todo", readStatus?: "reading"|"finished"|"assessing"|"unread"',
  },
  move_chapter: {
    name: "move_chapter",
    label: "调整节点顺序",
    risk: "write",
    description: "把阅读路线中的某个节点上移或下移一位（调整顺序，不改内容与状态）。需经确认卡。",
    params: "id?: string, title: string（书名）, chapterTitle: string（节点名）, dir: -1（上移）| 1（下移）",
  },
  save_reading_deposit: {
    name: "save_reading_deposit",
    label: "存阅读沉淀",
    risk: "write",
    description: "把一段理解/观点/问题保存为指定书（可带章节来源）的沉淀。type 取值：explanation 我的解释 / point 核心点 / question 问题 / view 我的观点 / practice 实践案例 / unresolved 待解决 / aiFeedback AI 反馈。保留用户原话，生成与保存要区分。需经确认卡。",
    params: "id?: string, title: string（书名）, chapterTitle?: string（章节名，缺省=整本书级）, type: string, text: string（用户认可的内容，尽量保留原话）",
  },
  link_notes: {
    name: "link_notes",
    label: "关联笔记",
    risk: "write",
    description: "在第二大脑的两条笔记之间建立双向关联（按标题或 id 定位）。不修改笔记正文。需经确认卡。",
    params: "from: string（笔记标题或 id）, to: string（另一篇笔记标题或 id）",
  },
  review_queue: {
    name: "review_queue",
    label: "复习队列",
    risk: "read",
    writeActions: ["enable", "record"],
    description:
      "复习队列：action=list 列出今天待复习与近期队列；action=enable 把笔记加入/移出复习队列（写，需确认）；action=record 提交一次复习表现（写，需确认）——依据用户真实作答，不凭模型判断伪造复习记录。",
    params: 'action: "list"|"enable"|"record", title?: string, id?: string, enabled?: boolean, ok?: boolean（record 用：用户这次答对了吗）',
  },
  memory: {
    name: "memory",
    label: "长期记忆",
    risk: "read",
    writeActions: ["remember", "forget"],
    description:
      "长期记忆：action=recall 按 query 检索；action=remember 记一条用户事实（写，需确认）；action=forget 删除一条（写）。只记关于用户本人的稳定事实（保留用户原话要点，不要过度改写），不记寒暄。",
    params: 'action: "recall"|"remember"|"forget", query?, text?, tags?: string[], id?',
  },
  reminders: {
    name: "reminders",
    label: "定时提醒",
    risk: "read",
    writeActions: ["create", "delete"],
    description:
      "定时提醒（到点发邮件）：action=list 列出；action=create 新建（写，需确认）；action=delete 删除（写）。用户说\"每天早上 8 点提醒我复习\"就用这个。",
    params: 'action: "list"|"create"|"delete", title?, prompt?, time?（HH:mm）, days?: number[]（0=周日）, id?',
  },
};

/** 写入类工具名单（单一事实来源派生）：整工具写入（risk:"write"）+ 含写动作的
 *  混合工具（writeActions），与 executeTool 的写分发、runner 的写轮次判定同源。
 *  消费方（如工作台「产物」聚合）据此过滤，禁止再手抄名单——此前的手抄 14 名单
 *  漏掉 update_book/remove_book/save_reading_deposit/edit_book_goal/set_reading_progress/
 *  move_chapter/link_notes/record_book_assessment/rebuild_reading_route/restore_book_route/
 *  manage_session/forge_persona/review_queue 等协议登记的写入工具，用户批准执行
 *  成功后「产物」栏对这批写入毫无痕迹。 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(
  (Object.entries(TOOLS) as [ToolName, ToolSpec][])
    .filter(([, spec]) => spec.risk === "write" || (spec.writeActions?.length ?? 0) > 0)
    .map(([name]) => name)
);

export interface ToolCall {
  id: string;
  name: ToolName;
  args: Record<string, unknown>;
  status: ToolStatus;
  /** 结果摘要（给 UI 显示，限长） */
  summary?: string;
  startedAt: number;
  endedAt?: number;
}

export interface PlanStep {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
}

/** 写入类工具的确认草稿：UI 渲染审批卡，用户批准后才真正执行 */
export interface PendingAction {
  id: string;
  /** 工具名，执行器按 kind 分发 */
  kind: ToolName;
  /** 卡片标题（如「新建笔记」） */
  label: string;
  /** 一句话摘要 */
  summary: string;
  /** 批准后交给执行器的参数 */
  payload: Record<string, unknown>;
}

export interface ApprovalDecision {
  actionId: string;
  approved: boolean;
}

/** 单轮最多工具调用轮数：防止模型无限循环烧钱 */
export const MAX_TOOL_ROUNDS = 5;

/** 工具调用结果的统一形状（回注给模型） */
export interface ToolResult {
  ok: boolean;
  /** 给模型看的文本（简洁、结构化） */
  content: string;
  /** 给 UI 看的摘要（更短） */
  summary: string;
}

/** 计划状态机：只允许 pending→in_progress→completed/skipped，禁止跳级 */
export function advancePlan(plan: PlanStep[], stepId: string, status: PlanStep["status"]): PlanStep[] {
  return plan.map((s) => {
    if (s.id !== stepId) return s;
    const legal: Record<PlanStep["status"], PlanStep["status"][]> = {
      pending: ["in_progress", "skipped"],
      in_progress: ["completed", "skipped"],
      completed: [],
      skipped: [],
    };
    return legal[s.status].includes(status) ? { ...s, status } : s;
  });
}

/** 计划推进一步（修复 v1 双推进 bug：每批工具只推进「当前步完成 → 下一步开始」一次） */
export function stepPlanForward(plan: PlanStep[]): PlanStep[] {
  const cur = plan.find((s) => s.status === "in_progress");
  if (!cur) return plan;
  let next = advancePlan(plan, cur.id, "completed");
  const nxt = next.find((s) => s.status === "pending");
  if (nxt) next = advancePlan(next, nxt.id, "in_progress");
  return next;
}

/** 递归按 key 排序序列化（仅用于签名）。
 *  不能用 JSON.stringify(args, keys)：replacer 数组是白名单且对每一层生效，
 *  嵌套对象会被滤成 {}——仅嵌套内容不同的两次调用会得到相同签名，被守卫误判为打转。 */
function stableStringify(value: unknown, stack: object[] = []): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    const obj = v as object;
    /* 只重排普通对象；Date/Map 等交给 JSON.stringify 原生 toJSON，避免序列化成 {} */
    const proto = Object.getPrototypeOf(obj);
    if (!Array.isArray(obj) && proto !== Object.prototype && proto !== null) return obj;
    if (stack.includes(obj)) return "[Circular]";
    stack.push(obj);
    const out = Array.isArray(obj)
      ? obj.map(walk)
      : Object.keys(obj as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = walk((obj as Record<string, unknown>)[k]);
            return acc;
          }, {});
    stack.pop();
    return out;
  };
  return JSON.stringify(walk(value));
}

/** 工具调用签名（用于打转检测） */
export function callSignature(name: ToolName, args: Record<string, unknown>): string {
  try {
    return `${name}:${stableStringify(args)}`;
  } catch {
    /* 兜底：序列化异常（循环引用/BigInt）不能让守卫抛错中断整轮对话 */
    try {
      return `${name}:${JSON.stringify(args)}`;
    } catch {
      return `${name}:${Object.keys(args).sort().join(",")}`;
    }
  }
}
