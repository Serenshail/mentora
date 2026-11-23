import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root=process.cwd(), out=path.join(root,'docs/agent-quality-prd-2026-11-15');
fs.mkdirSync(path.join(out,'sources'),{recursive:true});
const original=JSON.parse(fs.readFileSync(path.join(root,'docs/agent-experience-prd-2026-11-11/QUALITY-CASES.json'),'utf8'));
fs.copyFileSync(path.join(root,'docs/agent-experience-prd-2026-11-11/QUALITY-CASES.json'),path.join(out,'sources/previous-quality-cases.json'));
fs.copyFileSync('C:/Users/haozhe/.codex/attachments/bc64d6b1-70f7-4463-96cb-e4a050c993b3/已粘贴的文本.txt',path.join(out,'sources/teaching-reference.txt'));
const extra=[
 ['Q09','首页','calloc 与 malloc','calloc 和 malloc 有什么区别？我是初学者，请用同样三个整数的内存例子讲清。',['calloc 清零、malloc 未初始化','空指针与释放','不把 calloc 当成永不失败'],[]],
 ['Q10','学习教练','扩容不是插入','我知道扩容是申请更大空间，但还是不懂为什么扩容完插入中间还要移动。请用容量 4、长度 3、数组 [10,20,30] 在下标 1 插入 99 解释。',['区分容量、长度、元素位置','移动顺序由后向前','结果 [10,99,20,30]'],[]],
 ['Q11','学习教练','指针两层关系','struct List { int *data; int size; int capacity; }; 我分不清 List *L、L->data 和 &L->data，它们分别是什么？用内存示意解释，代码必须能对上图。',['List 指针、int 指针、int 双重指针','区分结构体地址和动态数组地址','不捏造固定内存地址为真实运行值'],[]],
 ['Q12','首页','英文与公式不丢失','请保留英文标题并解释这段内容：\nMemory Layout\n数组地址公式 address(a[i]) = base + i * sizeof(int)\nTime Complexity',['英文标题和公式原样可见','解释元素宽度与索引','显示与公开正文无误删'],[]],
 ['Q13','首页','不适用的检索不强加','只用下面这句话回答：我每周可学习 3 小时。问：我每周可学多少小时？不要联网。',['回答3小时','无联网、写入或额外澄清'],[]],
 ['Q14','首页','最新约束覆盖旧约束','按我现在的时间继续安排，不要用以前的两小时。',['采用每天30分钟','不再问已知时间','不自动写入计划'],[{role:'user',content:'以前我每天有两小时。'},{role:'assistant',content:'记下了每天两小时。'},{role:'user',content:'更正：现在每天只有30分钟，周末也一样。'}]],
 ['Q15','首页','预算内找回远处代码','上面那个 rotate 函数里为什么要先判断 n <= 0 再做 k %= n？只针对那段代码解释。',['结合Q01的实际代码','解释除零/非法长度','不能因为中间历史太长而猜代码'],[{role:'user',content:'请保留这段代码：void rotate(int*a,int n,int k){if(!a||n<=0||k<0)return;k%=n;/* ... */}'},...Array.from({length:14},(_,i)=>({role:i%2?'assistant':'user',content:`背景讨论${i+1}：我在学习C语言数组，继续理解下标。`}))]],
 ['Q16','首页','真的没有代码时不猜','帮我逐行解释那个程序。',['指出当前会话缺少程序','请求代码或明确对象一次','不编造所谓原程序'],[]],
 ['Q17','阅读','只解释实际选中章节','就当前这一章作者的论证，给我一个反例，区分作者主张与你的判断。',['使用fixture reading-1/ch-1的材料','反例针对论证','不替换成其他书'],[]],
 ['Q18','阅读','材料不足不编引用','这一章原文里哪一句支持这个观点？请给我原句和所在段落。',['fixture未提供原文时明确无法核对','不捏造逐字引文、页码','提供补材料路径'],[]],
 ['Q19','阅读','理解不等于读完','我读完这一章了，但讲不出来。能算掌握了吗？',['读完与掌握分开','针对性追问或练习','不得伪造验收成绩'],[]],
 ['Q20','人生伙伴','有约束的建议','我想辞职创业，但存款只够三个月，还有房租。请给出判断、风险和这一周能做的一步，不要泛泛鸡汤。',['使用三个月约束','关键不确定性','可执行的小规模验证而非保证成功'],[]],
 ['Q21','圆桌','有真实差异的综合','用当前圆桌已完成发言，区分共识、真正分歧和下一步。',['依据fixture rt-1发言','不编造未发言者意见','失败席位不当成已完成'],[]],
 ['Q22','首页','学习计划预览不写入','先给我看把Python第二阶段改成每周三小时的方案，不要应用。',['绑定g-python/p-files','展示具体差异','数据库/store零写入'],[]],
 ['Q23','首页','批准后对象一致','同意应用刚才的方案，只改第二阶段未完成部分。',['沿用Q22审批产物','g-python原稳定ID不变','已完成课、成绩、笔记不变','专业页可见且可继续'],[{role:'user',content:'本题必须先执行Q22得到真实预览与待确认卡，再通过真实界面批准；不要把这段说明当成用户批准替身。'}]],
 ['Q24','首页','取消后无后台写入','取消刚才那个调整，不要再修改。',['依照Q22待确认初态真实取消','没有后续写入','不显示操作成功'],[]],
 ['Q25','首页','歧义目标不误改','把Python第二阶段改成每周三小时。',['fixture包含两个同名Python目标时先消歧','不得默认选择第一项','澄清阶段零写入'],[]],
 ['Q26','学习教练','可运行的完整示范','请写完整的C程序演示安全扩容并插入：初始[10,20,30]，容量3，下标1插入99；解释realloc失败时旧数据怎么办。',['完整头文件/主函数/释放路径','临时指针保护旧地址','编译运行输出10 99 20 30'],[]],
 ['Q27','首页','混合中英文代码保真','请用中文解释下面代码，保留标题和代码，不要翻译变量名：\nBoundary Cases\n```c\nif (n <= 0) return;\nk %= n;\n```',['保留Boundary Cases','代码两行保持','中文解释不删除英文'],[]],
 ['Q28','首页','用户错误不迎合','三次反转时k=0，第二次和第三次都为空，所以第一次会把数组倒过来，对吗？',['明确指出第三次为整个数组','给出反转前后状态','不附和错误结论'],[]],
 ['Q29','学习教练','简短追问精准展开','为什么 realloc 返回后不能马上就用旧的 data？只讲这个问题，不要从头介绍顺序表。',['旧地址可能失效','成功/失败两种路径区分','不重讲全章'],[]],
 ['Q30','首页','联网失败如实回答','帮我查一个今天刚发布的版本更新；如果查不到就直说，别按印象写最新版本。',['工具故障fixture中明确未核实','不假装已读官方公告','给出可恢复下一步'],[]],
];
const cases=[...original.cases.map(c=>({...c,entry:'首页',status:'NOT_RUN'})),...extra.map(([id,entry,title,input,mustInclude,history])=>({id,entry,title,messages:[...history,{role:'user',content:input}],mustInclude,forbidden:['捏造证据或执行结果','跨会话或账户串写'],status:'NOT_RUN'}))];
for (const id of ['Q23','Q24']) {
  const c=cases.find(c=>c.id===id);
  c.messages=c.messages.slice(-1);
  c.setup={caseId:'Q22',freshSeed:true,actualPendingApprovalRequired:true,includeSetupUsage:true};
  c.execution={entry:'真实审批入口',action:id==='Q23'?'approve':'cancel',intent:c.messages[0].content,providerInput:'通过产品真实入口生成；准备信息不得注入，不得同时重复发送批准/取消消息'};
}
const fixtures={
  coding:'同一编译器/标准C11；原材料完整保留。Q01-Q08沿用原始用例的mustInclude/forbidden，不变更答案。',
  learning:'g-python标题Python：p-basics已完成、p-files第二阶段含done-day成绩和关联笔记、todo-1/todo-2未完成。另有g-rust置于列表首位。Q25另有g-python-2同名目标。种子按当前schema构建并冻结全量哈希。',
  reading:'reading-1/ch-1：提供材料“作者认为每天固定读一页比等有空再读更容易保持习惯，依据是行动门槛更低”；这是测试材料，不归属于真实出版物。Q18故意不提供原著全文、页码或逐字引文。',
  council:'rt-1已完成A：先验证需求；B：优先守住现金流；C失败。共识先小规模验证，差异为风险与投入节奏，不得补写C意见。',
  action:'Q23必须在独立种子上先真实执行Q22作为setup；其setup调用和token记账。Q24同样先准备待审批卡；Q25独立消歧初态。Q23/Q24的setup与execution均为测试元数据，不能发给模型；messages仅保留用户意图。执行真实审批控件并记录其生成的正式请求，禁止再额外发送一次批准/取消消息。',
  failure:'Q07/Q30将检索故障作为工具层真实错误注入，不以用户消息暗示失败；成功路径与故障路径证据分列。',
};
fs.writeFileSync(path.join(out,'QUALITY-CASES.json'),JSON.stringify({version:'1.0',status:'NOT_RUN',cases,fixtures,baseline:'同模型同参数同种子；旧新各两遍；所有调用含setup、retry计费；不得择优重跑'},null,2));
const rows=[
 ['A01','P01','首页/390','工具开始→完成→回答','消息内过程区可见，不需要打开右栏'],
 ['A02','P01','四宽度','过程展开/收起各50次','选择不被流式增量重置；aria-expanded一致；无横溢'],
 ['A03','P02','隔离双会话','A运行→切B→A迟到事件','B无A的正文、过程、审批或位置变化'],
 ['A04','P02','事件流','重复eventId/乱序seq/相同toolCallId','幂等更新，最终状态正确无重复步骤'],
 ['A05','P02','无公开摘要供应商','仅h心跳且无工具事件','显示真实等待耗时，不编造步骤或公开隐藏推理'],
 ['A06','P02','公开摘要适配器','明确public summary分块','按来源显示安全短摘要；与d正文分开；不新增模型请求'],
 ['A07','P03','虚拟时钟','仅心跳持续60秒','10秒等待提示/30秒可恢复提示；无假业务进展'],
 ['A08','P03','可控流','completed/failed/cancelled/partial各一次','终态250ms内停止spinner并显示正确状态'],
 ['A09','P03','审批挂起','等待60秒→拒绝','不误判模型超时；拒绝不写入、不报成功'],
 ['A10','P03','流式中断','正文一半断流','保留正文标不完整；停止上游；重试新run不重放写入'],
 ['A11','P03','运行中刷新','刷新再进入','interrupted可见；provider与写操作自动重放均为0'],
 ['A12','P02','包含敏感参数工具','过程与保存记录检查','无Key/凭据/隐藏推理/原始堆栈；精简数据兼容旧消息'],
 ['A13','P01','旧消息无过程字段','打开/刷新/跨页','正文可读无空白过程框，无迁移清空'],
 ['A14','S01','首页历史上翻','有效输入发送','DOM/容器就绪两帧内底距≤4px'],
 ['A15','S02','首次发送无消息容器','普通跟随与force同帧排队','force不丢，新容器出现两帧内回底'],
 ['A16','S03','正在输出','用户向上滚后再发20个增量','阅读锚点保持，出现回到最新，不强拉回底'],
 ['A17','S03','暂停跟随','点击回到底部/再次发送','恢复following并准确回底'],
 ['A18','S04','跟随模式','图片加载/表格撑高/展开过程','跟随时仍贴底；暂停时不抢位置'],
 ['A19','S05','A已排队rAF','切B再执行A帧','B位置不变；旧帧取消或身份检查拒绝'],
 ['A20','S05','双账号与卸载','切账号/卸载后flush队列','无旧滚动或事件写入；listener/observer回到基线'],
 ['A21','S06','学习教练长讲义','首页后台任务继续输出','学习页/window位置不被首页改动'],
 ['A22','S06','会话超过10条','加载更早记录','旧记录真实出现，阅读锚点偏移≤4px'],
 ['A23','S04','1000增量/四宽度','记录rAF写入与最终正文','每帧最多一次滚动写入，正文无丢字重复；横溢≤2px'],
 ['A24','Q01','四业务入口','深讲/重讲/简答/动作路由矩阵','模式与用户明确请求一致，不重复确认清晰材料'],
 ['A25','Q02','长历史/小窗口','最终请求与预算清单','含system/tools/历史/证据/输出预留；超限不静默剪代码'],
 ['A26','Q02','旧约束被纠正','新约束/对象版本更新后检索','旧事实不覆盖新事实；缓存失效；不串对象'],
 ['A27','Q02','同一工具结果两通道','检查最终provider payload','完整证据只注入一次，来源可追溯'],
 ['A28','Q03','中英/公式/代码混合','对比公开原文与最终显示','合法内容不被清洗误删，代码可运行'],
 ['A29','Q01','QUALITY-CASES 30题','旧新各两次，盲评','均分≥90；27题两次≥85；关键失败0；分维度达标'],
 ['A30','成本','相同30题','统计全链路usage与费用','总token≤1.15倍/简答≤1.05/深讲≤1.25；unknown不算0'],
 ['A31','成本','dry-run/预算不足','尝试启动或超出预算','默认0次调用；超限停止不改预算；辅助调用也计账'],
 ['A32','正确性','首页修改计划→专业页','预览→取消/批准→刷新','取消零写入；批准指定对象可见，已完成资产保留'],
 ['A33','质量','阅读/圆桌失败席位','材料缺失/部分失败','不编原文或失败席位发言，能继续恢复'],
 ['A34','门禁','当前源码','tsc/ESLint/测试/build','独立exit code与原日志齐全，不降规则删失败'],
 ['A35','交付','独立主智能体验收','随机抽查源码/输出/实际对象','可复核，未跑项不标PASS，不能自行最终签收'],
];
const quote=s=>'"'+String(s).replaceAll('"','""')+'"';
fs.writeFileSync(path.join(out,'ACCEPTANCE.csv'),[['id','requirement','precondition','steps','expected','status','evidence','reviewer'],...rows.map(r=>[...r,'NOT_RUN','',''])].map(r=>r.map(quote).join(',')).join('\n'));
const localFiles=['src/components/agent-home.tsx','src/components/agent-trace.tsx','src/lib/agent/runner.ts','src/lib/agent/session-runtime.ts','src/lib/ai/client.ts','src/lib/ai/prompts.ts','src/lib/ai/prompts-lite.ts','src/app/api/chat/route.ts','src/lib/types.ts'];
const refRoot='D:/zcode/agent/output/xingyao-reference-2026-11-15';
const refFiles=['frontend/src/components/MessageBubble.vue','frontend/src/composables/useChatScroll.ts','frontend/src/composables/useChatScroll.test.ts','core/context_builder.py','core/thinking_stream.py','core/reasoning_stream.py','LICENSE'];
const meta=(base,p)=>({path:p,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(base,p))).digest('hex')});
fs.writeFileSync(path.join(out,'source-manifest.json'),JSON.stringify({generatedAt:new Date().toISOString(),referenceCommit:'e827a976caf04aee9ba6d8d03486b7ee1c0524fd',referenceRoot:refRoot,referenceFiles:refFiles.map(p=>meta(refRoot,p)),localRoot:root,localFiles:localFiles.map(p=>meta(root,p)),caseCount:cases.length,acceptanceCount:rows.length},null,2));
if(cases.length!==30||new Set(cases.map(c=>c.id)).size!==30)throw Error('Quality case IDs invalid');
if(new Set(rows.map(r=>r[0])).size!==rows.length)throw Error('Acceptance IDs invalid');
for(const p of ['README.md','PRD.md','REFERENCE-AND-DIAGNOSIS.md','EXECUTION-AND-ACCEPTANCE.md','HANDOFF.md'])if(!fs.existsSync(path.join(out,p)))throw Error('Missing '+p);
fs.writeFileSync(path.join(out,'DOCUMENT-CHECKS.md'),`# 文档结构检查\n\n30 条质量题、${rows.length} 条验收场景；编号唯一；JSON 可解析；必交文档与原样例存在；源码和参考文件哈希已记录。所有场景均 NOT_RUN。\n\n这只是文档结构检查通过，不是 UI、模型或业务验收通过。\n`);
console.log(JSON.stringify({qualityCases:cases.length,acceptanceCases:rows.length,status:'DOCUMENTS_VALIDATED_PRODUCT_NOT_RUN'}));
