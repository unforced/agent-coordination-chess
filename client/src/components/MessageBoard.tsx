import { useEffect, useRef } from "react";
import type { BoardMessage, Team, AgentConfig } from "../../../shared/types";
import AgentBadge from "./AgentBadge";

interface MessageBoardProps {
  team: Team;
  messages: BoardMessage[];
  agents: AgentConfig[];
}

export default function MessageBoard({
  team,
  messages,
  agents,
}: MessageBoardProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const agentModelMap = new Map(agents.map((a) => [a.id, a.model]));
  const teamLabel = team === "white" ? "WHITE TEAM" : "BLACK TEAM";
  const dotColor =
    team === "white" ? "var(--white-team)" : "var(--black-team)";

  return (
    <div className="panel message-board">
      <div className={`panel__header panel__header--${team}`}>
        <span
          className="panel__header-dot"
          style={{ background: dotColor }}
        />
        {teamLabel}
      </div>
      <div className="panel__body" ref={scrollRef}>
        {messages.length === 0 && (
          <div
            style={{
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              textAlign: "center",
              padding: "24px 0",
            }}
          >
            Waiting for deliberation...
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`message message--${team}`}>
            <div className="message__header">
              <div className="message__agent">
                <AgentBadge
                  name={msg.agentName}
                  model={agentModelMap.get(msg.agentId)}
                />
              </div>
              <span className="message__tokens">{msg.tokenCount} tok</span>
            </div>
            <div className="message__content">{msg.content}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
