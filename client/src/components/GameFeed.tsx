import { useEffect, useRef, useMemo } from "react";
import Markdown from "react-markdown";
import type { BoardMessage, MoveRecord, Team, AgentConfig, GamePhase } from "../../../shared/types";
import AgentBadge from "./AgentBadge";

type FeedItem =
  | { kind: "message"; data: BoardMessage; team: Team }
  | { kind: "move"; data: MoveRecord }
  | { kind: "postgame"; data: BoardMessage };

interface GameFeedProps {
  messages: { white: BoardMessage[]; black: BoardMessage[] };
  postGameMessages: BoardMessage[];
  moveHistory: MoveRecord[];
  agents: AgentConfig[];
  activeAgentId: string | null;
  currentTurn: Team;
  turnNumber: number;
  phase: GamePhase;
  onAgentClick?: (agentName: string) => void;
}

export default function GameFeed({
  messages, postGameMessages, moveHistory, agents,
  activeAgentId, currentTurn, turnNumber, phase, onAgentClick,
}: GameFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const feed = useMemo(() => {
    const items: (FeedItem & { sortKey: number })[] = [];

    for (const msg of messages.white) {
      items.push({ kind: "message", data: msg, team: "white", sortKey: msg.timestamp });
    }
    for (const msg of messages.black) {
      items.push({ kind: "message", data: msg, team: "black", sortKey: msg.timestamp });
    }
    for (const move of moveHistory) {
      items.push({ kind: "move", data: move, sortKey: move.timestamp });
    }
    for (const msg of postGameMessages) {
      items.push({ kind: "postgame", data: msg, sortKey: msg.timestamp });
    }

    items.sort((a, b) => a.sortKey - b.sortKey);
    return items;
  }, [messages, moveHistory, postGameMessages]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [feed, activeAgentId]);

  const activeAgent = agents.find((a) => a.id === activeAgentId);

  const phaseLabel = phase === "post_game_reflection" ? "POST-GAME REFLECTION"
    : phase === "post_game_discussion" ? "POST-GAME DISCUSSION"
    : null;

  return (
    <div className="panel game-feed">
      <div className="panel__header">
        GAME FEED
        <span className="message-board__count">
          {phaseLabel ?? `Turn ${turnNumber}`}
        </span>
      </div>
      <div className="panel__body" ref={scrollRef}>
        {feed.length === 0 && !activeAgent && (
          <div className="game-feed__empty">Waiting for game to begin...</div>
        )}

        {feed.map((item) => {
          if (item.kind === "move") {
            const move = item.data;
            const teamColor = move.team === "white" ? "var(--white-team)" : "var(--black-team)";
            return (
              <div key={`move-${move.turnNumber}`} className="game-feed__move">
                <span className="game-feed__move-dot" style={{ background: teamColor }} />
                <span className="game-feed__move-label">{move.team.toUpperCase()}</span>
                <span className="game-feed__move-san" style={{ color: teamColor }}>{move.move}</span>
                <span
                  className="game-feed__move-by"
                  style={{ cursor: "pointer" }}
                  onClick={() => onAgentClick?.(move.selectedAgentName)}
                >
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
                  <div
                    className="message__agent"
                    style={{ cursor: "pointer" }}
                    onClick={() => onAgentClick?.(msg.agentName)}
                  >
                    <AgentBadge name={msg.agentName} model={agent?.model} />
                    <span className={`game-feed__team-tag game-feed__team-tag--${item.team}`}>
                      {item.team}
                    </span>
                  </div>
                </div>
                <div className="message__content"><Markdown>{msg.content}</Markdown></div>
              </div>
            );
          }

          if (item.kind === "postgame") {
            const msg = item.data;
            const agent = agentMap.get(msg.agentId);
            return (
              <div key={msg.id} className="message message--postgame">
                <div className="message__header">
                  <div
                    className="message__agent"
                    style={{ cursor: "pointer" }}
                    onClick={() => onAgentClick?.(msg.agentName)}
                  >
                    <AgentBadge name={msg.agentName} model={agent?.model} />
                    <span className="game-feed__team-tag game-feed__team-tag--postgame">review</span>
                  </div>
                </div>
                <div className="message__content"><Markdown>{msg.content}</Markdown></div>
              </div>
            );
          }

          return null;
        })}

        {phaseLabel && (
          <div className="game-feed__phase-banner">{phaseLabel}</div>
        )}

        {activeAgent && (
          <div className={`message-board__thinking message-board__thinking--${currentTurn}`}>
            <AgentBadge name={activeAgent.name} model={activeAgent.model} />
            <span className="message-board__thinking-dots">
              {phase?.startsWith("post_game") ? "reflecting..." : "thinking..."}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
