import { useEffect, useRef, useMemo } from "react";
import Markdown from "react-markdown";
import type { BoardMessage, MoveRecord, Team, AgentConfig, GamePhase } from "../../../shared/types";
import AgentBadge from "./AgentBadge";

type FeedItem =
  | { kind: "message"; data: BoardMessage; team: Team }
  | { kind: "move"; data: MoveRecord }
  | { kind: "turn"; turnNumber: number; team: Team };

interface GameFeedProps {
  messages: { white: BoardMessage[]; black: BoardMessage[] };
  moveHistory: MoveRecord[];
  agents: AgentConfig[];
  activeAgentId: string | null;
  currentTurn: Team;
  turnNumber: number;
  phase: GamePhase;
}

export default function GameFeed({
  messages,
  moveHistory,
  agents,
  activeAgentId,
  currentTurn,
  turnNumber,
  phase,
}: GameFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const agentMap = useMemo(
    () => new Map(agents.map((a) => [a.id, a])),
    [agents]
  );

  // Build a unified chronological feed
  const feed = useMemo(() => {
    const items: (FeedItem & { sortKey: number })[] = [];

    // Add all messages — use timestamp for ordering
    for (const msg of messages.white) {
      items.push({ kind: "message", data: msg, team: "white", sortKey: msg.timestamp });
    }
    for (const msg of messages.black) {
      items.push({ kind: "message", data: msg, team: "black", sortKey: msg.timestamp });
    }

    // Add move announcements using the move's own timestamp
    for (const move of moveHistory) {
      items.push({ kind: "move", data: move, sortKey: move.timestamp });
    }

    items.sort((a, b) => a.sortKey - b.sortKey);
    return items;
  }, [messages, moveHistory]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [feed, activeAgentId]);

  const activeAgent = agents.find((a) => a.id === activeAgentId);

  return (
    <div className="panel game-feed">
      <div className="panel__header">
        GAME FEED
        <span className="message-board__count">
          Turn {turnNumber}
        </span>
      </div>
      <div className="panel__body" ref={scrollRef}>
        {feed.length === 0 && !activeAgent && (
          <div className="game-feed__empty">
            Waiting for game to begin...
          </div>
        )}

        {feed.map((item, i) => {
          if (item.kind === "move") {
            const move = item.data;
            const teamColor = move.team === "white" ? "var(--white-team)" : "var(--black-team)";
            return (
              <div key={`move-${move.turnNumber}`} className="game-feed__move">
                <span
                  className="game-feed__move-dot"
                  style={{ background: teamColor }}
                />
                <span className="game-feed__move-label">
                  {move.team.toUpperCase()}
                </span>
                <span className="game-feed__move-san" style={{ color: teamColor }}>
                  {move.move}
                </span>
                <span className="game-feed__move-by">
                  by {move.selectedAgentName}
                </span>
              </div>
            );
          }

          if (item.kind === "message") {
            const msg = item.data;
            const agent = agentMap.get(msg.agentId);
            return (
              <div key={msg.id} className={`message message--${item.team}`}>
                <div className="message__header">
                  <div className="message__agent">
                    <AgentBadge
                      name={msg.agentName}
                      model={agent?.model}
                    />
                    <span className={`game-feed__team-tag game-feed__team-tag--${item.team}`}>
                      {item.team}
                    </span>
                  </div>
                </div>
                <div className="message__content">
                  <Markdown>{msg.content}</Markdown>
                </div>
              </div>
            );
          }

          return null;
        })}

        {phase === "post_game_deliberation" && (
          <div className="game-feed__move" style={{ borderColor: "var(--border-medium)" }}>
            <span className="game-feed__move-san" style={{ color: "var(--text-secondary)", fontSize: 12 }}>
              POST-GAME REVIEW
            </span>
            <span className="game-feed__move-by">agents updating notepads...</span>
          </div>
        )}

        {activeAgent && (
          <div className={`message-board__thinking message-board__thinking--${currentTurn}`}>
            <AgentBadge name={activeAgent.name} model={activeAgent.model} />
            <span className="message-board__thinking-dots">
              {phase === "post_game_deliberation" ? "reviewing..." : "thinking..."}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
