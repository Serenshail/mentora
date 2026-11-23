import type { Goal } from "@/lib/types";
import { useAppStore } from "@/lib/store";

export const goalKey = (text: string) => text.normalize("NFKC").trim().toLocaleLowerCase();
export function goalSummary(goal: Goal) {
  const days=Object.values(goal.plan?.days ?? {});
  return { id:goal.id, topic:goal.topic, status:goal.status, direction:goal.direction?.slice(0,160) || "", createdAt:goal.createdAt,
    done:days.filter(d=>d.status==="passed").length,total:days.length,currentDay:days.find(d=>d.status==="active")?.title ?? null,
    phases:(goal.plan?.phases ?? []).map((p,index)=>({index:index+1,id:p.id,title:p.title})) };
}

/** A live, bounded index; details are fetched by stable id instead of embedding every plan. */
export function buildAppContext(question="") {
  const s=useAppStore.getState();
  const pathname=typeof window==="undefined"?"":window.location.pathname;
  const routeGoalId=pathname.match(/^\/learn\/([^/]+)$/)?.[1];
  const routeWorkspaceId=pathname.match(/^\/workspace\/([^/]+)$/)?.[1];
  const query=goalKey(question);
  const ranked=[...s.goals].sort((a,b)=>{
    const score=(g:Goal)=>(g.id===routeGoalId?100:0)+(query.includes(goalKey(g.topic))&&g.topic?20:0)+(g.status==="active"?1:0);
    return score(b)-score(a);
  });
  const goals=ranked.slice(0,30).map(g=>{const {phases,...summary}=goalSummary(g);return {...summary,phaseCount:phases.length};});
  return JSON.stringify({observedAt:new Date().toISOString(),currentPage:pathname,currentGoalId:routeGoalId??null,currentWorkspaceId:routeWorkspaceId??null,
    goalCount:s.goals.length,activeGoalCount:s.goals.filter(g=>g.status==="active").length,goals,hasMoreGoals:s.goals.length>goals.length,
    lookup:"需要完整列表时调用 list_goals(query?,status?,offset?,limit?)；同名以 id、方向、创建时间、当前进度消歧，不能默认第一项。",
    workspaces:s.knowledge.filter(k=>k.workspace).slice(0,20).map(k=>({id:k.id,title:k.title,version:k.version??1})),
    recentStruggles:ranked.slice(0,4).flatMap(g=>(g.quizLog??[]).slice(-2).flatMap(q=>q.items.filter(i=>i.verdict!=="correct").slice(0,2).map(i=>({goalId:g.id,dayId:q.dayId,question:i.question.slice(0,200),verdict:i.verdict})))),
    knowledgeCount:s.knowledge.length,bookCount:s.books.length,sessionCount:s.sessions.length,
    dueReviews:s.knowledge.filter(k=>k.nextReviewAt&&k.nextReviewAt<=new Date().toISOString().slice(0,10)).length});
}
