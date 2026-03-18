import type { ClaudeModel } from "../../../shared/types";

interface AgentBadgeProps {
  name: string;
  model?: ClaudeModel;
}

const modelClassMap: Record<ClaudeModel, string> = {
  opus: "agent-badge__dot--opus",
  sonnet: "agent-badge__dot--sonnet",
  haiku: "agent-badge__dot--haiku",
};

export default function AgentBadge({ name, model }: AgentBadgeProps) {
  const dotClass = model ? modelClassMap[model] : "agent-badge__dot--sonnet";

  return (
    <span className="agent-badge">
      <span className={`agent-badge__dot ${dotClass}`} />
      {name}
    </span>
  );
}
