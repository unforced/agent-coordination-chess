import { useState, useEffect, useRef, useCallback } from "react";
import type { AgentConfig } from "../../../shared/types";
import type { AgentThinking } from "../hooks/useGameSocket";

interface AgentStreamProps {
  agents: AgentConfig[];
  streams: Record<string, AgentThinking>;
  activeAgentId: string | null;
}

export default function AgentStream({
  agents,
  streams,
  activeAgentId,
}: AgentStreamProps) {
  const [selectedTab, setSelectedTab] = useState<string>(
    agents.length > 0 ? agents[0].id : ""
  );
  // Track if user has manually selected a tab — don't auto-switch if so
  const userSelectedRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const agentIds = agents.map((a) => a.id).join(",");

  // Reset manual selection when agents change (new game)
  useEffect(() => {
    userSelectedRef.current = false;
    if (agents.length > 0) {
      setSelectedTab(agents[0].id);
    }
  }, [agentIds]);

  // Only auto-switch if user hasn't manually picked a tab
  useEffect(() => {
    if (!userSelectedRef.current && activeAgentId && agents.some((a) => a.id === activeAgentId)) {
      setSelectedTab(activeAgentId);
    }
  }, [activeAgentId, agentIds]);

  // Auto-scroll when content changes for the selected tab
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [streams[selectedTab]?.content, selectedTab]);

  const handleTabClick = useCallback((agentId: string) => {
    userSelectedRef.current = true;
    setSelectedTab(agentId);
  }, []);

  const selectedStream = streams[selectedTab];

  const modelColorMap: Record<string, string> = {
    opus: "var(--model-opus)",
    sonnet: "var(--model-sonnet)",
    haiku: "var(--model-haiku)",
  };

  const teamColorMap: Record<string, string> = {
    white: "var(--white-team)",
    black: "var(--black-team)",
  };

  return (
    <div className="panel agent-streams">
      <div className="panel__header">AGENT THINKING STREAMS</div>
      <div className="agent-streams__tabs">
        {agents.map((agent) => {
          const isSelected = selectedTab === agent.id;
          const isCurrentAgent = activeAgentId === agent.id;
          const hasContent = !!streams[agent.id];
          let tabClass = "agent-streams__tab";
          if (isCurrentAgent && isSelected) tabClass += " agent-streams__tab--selected-mover";
          else if (isSelected) tabClass += " agent-streams__tab--active";

          const modelLabel = agent.model.charAt(0).toUpperCase() + agent.model.slice(1);

          return (
            <button
              key={agent.id}
              className={tabClass}
              onClick={() => handleTabClick(agent.id)}
            >
              {/* Team color bar */}
              <span
                style={{
                  width: 3,
                  height: 14,
                  borderRadius: 2,
                  background: teamColorMap[agent.team] || "var(--text-muted)",
                  flexShrink: 0,
                }}
              />
              {/* Model color dot */}
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: modelColorMap[agent.model] || "var(--text-muted)",
                  flexShrink: 0,
                }}
              />
              {agent.name}
              <span
                style={{
                  fontSize: 9,
                  opacity: 0.6,
                  color: modelColorMap[agent.model] || "var(--text-muted)",
                }}
              >
                {modelLabel}
              </span>
              {/* Currently thinking indicator */}
              {isCurrentAgent && (
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: "var(--accent-success)",
                    animation: "pulse-urgent 1s infinite",
                    flexShrink: 0,
                  }}
                />
              )}
              {/* Has content but not selected indicator */}
              {hasContent && !isSelected && !isCurrentAgent && (
                <span
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: "50%",
                    background: "var(--text-muted)",
                    flexShrink: 0,
                  }}
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="agent-streams__content" ref={contentRef}>
        {selectedStream ? (
          selectedStream.content
        ) : (
          <div className="agent-streams__empty">
            {agents.length > 0
              ? "No thinking stream yet — select an agent tab"
              : "No agents configured"}
          </div>
        )}
      </div>
    </div>
  );
}
