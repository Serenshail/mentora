import { redirect } from "next/navigation";

/* V26.1 决策①：学习人生并入「学习」工作台第三 tab。
 * 入口重定向；保留 /life 路由兼容旧链接。 */
export default function LifeIndexPage() {
  redirect("/learn?tab=life");
}
