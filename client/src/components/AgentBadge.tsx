import type { ClaudeModel } from "../../../shared/types";

interface AgentBadgeProps {
  name: string;
  model?: ClaudeModel;
  showModel?: boolean;
}

const modelClassMap: Record<ClaudeModel, string> = {
  opus: "agent-badge__dot--opus",
  sonnet: "agent-badge__dot--sonnet",
  haiku: "agent-badge__dot--haiku",
};

const modelLabelMap: Record<ClaudeModel, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

export default function AgentBadge({ name, model, showModel = true }: AgentBadgeProps) {
  const dotClass = model ? modelClassMap[model] : "agent-badge__dot--sonnet";

  return (
    <span className="agent-badge">
      <span className={`agent-badge__dot ${dotClass}`} />
      {name}
      {showModel && model && (
        <span className={`agent-badge__model agent-badge__model--${model}`}>
          {modelLabelMap[model]}
        </span>
      )}
    </span>
  );
}
