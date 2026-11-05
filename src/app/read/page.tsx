import { redirect } from "next/navigation";

/* v23.3：读书伙伴并入「学习」工作台（/learn?tab=read）。
 * 列表入口重定向；书籍详情 /read/[id] 保留原路由（深链/智能体产物跳转不变）。 */
export default function ReadIndexPage() {
  redirect("/learn?tab=read");
}
