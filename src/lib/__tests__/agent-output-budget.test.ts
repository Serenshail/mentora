import {afterEach,expect,it,vi} from "vitest";
import {agentOutputBudget} from "../server/agent-budget";
afterEach(()=>vi.unstubAllEnvs());
it("普通任务与深讲有不同预算，含供应商计算在输出中的推理token",()=>{
  vi.stubEnv("AGENT_OUTPUT_TOKENS","");vi.stubEnv("AGENT_DEEP_OUTPUT_TOKENS","");
  expect(agentOutputBudget()).toBe(4096);expect(agentOutputBudget({deep:true})).toBe(16000);
});
it("部署参数可降低预算，异常或过大的值不能取消上限",()=>{
  vi.stubEnv("AGENT_OUTPUT_TOKENS","2048");expect(agentOutputBudget()).toBe(2048);
  vi.stubEnv("AGENT_DEEP_OUTPUT_TOKENS","999999");expect(agentOutputBudget({deep:true})).toBe(16000);
  vi.stubEnv("AGENT_OUTPUT_TOKENS","garbage");expect(agentOutputBudget()).toBe(4096);
});
