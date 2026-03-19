import { useRef, useEffect } from "react";
import type { AgentProfile } from "../../../shared/types";
import type { AgentThinking } from "../hooks/useGameSocket";

interface AgentProfilePanelProps {
  agentName: string;
  profile: AgentProfile | null;
  stream: AgentThinking | null;
  onClose: () => void;
}

export default function AgentProfilePanel({
  agentName,
  profile,
  stream,
  onClose,
}: AgentProfilePanelProps) {
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [stream?.content]);

  return (
    <div className="agent-profile">
      <div className="agent-profile__header">
        <span className="agent-profile__name">{agentName}</span>
        <button className="agent-profile__close" onClick={onClose}>&times;</button>
      </div>

      <div className="agent-profile__body">
        {/* Self-definition */}
        <div className="agent-profile__section">
          <div className="agent-profile__label">IDENTITY</div>
          <div className="agent-profile__content">
            {profile?.selfDefinition || "Not yet defined..."}
          </div>
        </div>

        {/* Strategy */}
        <div className="agent-profile__section">
          <div className="agent-profile__label">STRATEGY</div>
          <div className="agent-profile__content">
            {profile?.strategy || "No strategy yet..."}
          </div>
        </div>

        {/* Current thinking stream */}
        <div className="agent-profile__section agent-profile__section--stream">
          <div className="agent-profile__label">THINKING STREAM</div>
          <div className="agent-profile__stream" ref={streamRef}>
            {stream ? stream.content : "No activity yet..."}
          </div>
        </div>
      </div>
    </div>
  );
}
