import { useState, useEffect, useRef } from "react";
import type { AgentConfig } from "../../../shared/types";
import type { AgentThinking } from "../hooks/useGameSocket";

interface AgentStreamProps {
  agents: AgentConfig[];
  streams: Record<string, AgentThinking>;
  selectedMoverId: string | null;
}

export default function AgentStream({
  agents,
  streams,
  selectedMoverId,
}: AgentStreamProps) {
  const [activeTab, setActiveTab] = useState<string>(
    agents.length > 0 ? agents[0].id : ""
  );
  const contentRef = useRef<HTMLDivElement>(null);

  // Auto-scroll when new content appears
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [streams, activeTab]);

  // Set first agent as active if not set
  useEffect(() => {
    if (!activeTab && agents.length > 0) {
      setActiveTab(agents[0].id);
    }
  }, [agents, activeTab]);

  const activeStream = streams[activeTab];

  const modelColorMap: Record<string, string> = {
    opus: "var(--model-opus)",
    sonnet: "var(--model-sonnet)",
    haiku: "var(--model-haiku)",
  };

  return (
    <div className="panel agent-streams">
      <div className="panel__header">AGENT THINKING STREAMS</div>
      <div className="agent-streams__tabs">
        {agents.map((agent) => {
          const isActive = activeTab === agent.id;
          const isSelectedMover = selectedMoverId === agent.id;
          let tabClass = "agent-streams__tab";
          if (isSelectedMover) tabClass += " agent-streams__tab--selected-mover";
          else if (isActive) tabClass += " agent-streams__tab--active";

          return (
            <button
              key={agent.id}
              className={tabClass}
              onClick={() => setActiveTab(agent.id)}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: modelColorMap[agent.model] || "var(--text-muted)",
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              {agent.name}
              {streams[agent.id] && (
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: "var(--accent-success)",
                    animation: "pulse-urgent 1s infinite",
                  }}
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="agent-streams__content" ref={contentRef}>
        {activeStream ? (
          activeStream.content
        ) : (
          <div className="agent-streams__empty">
            {agents.length > 0
              ? "No thinking stream yet..."
              : "No agents configured"}
          </div>
        )}
      </div>
    </div>
  );
}
