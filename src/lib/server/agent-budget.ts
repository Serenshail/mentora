/** Completion budget includes hidden reasoning when the provider counts it there. */
export function agentOutputBudget(args:Record<string,unknown>={}) {
  const deep=args.deep===true||args.compactAnswer===true;
  const configured=Number(deep?process.env.AGENT_DEEP_OUTPUT_TOKENS:process.env.AGENT_OUTPUT_TOKENS);
  return Number.isFinite(configured)&&configured>=1024?Math.min(16000,Math.floor(configured)):deep?16000:4096;
}
