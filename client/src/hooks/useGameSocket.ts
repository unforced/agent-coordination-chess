import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GameState,
  GameConfig,
  BoardMessage,
  ServerEvent,
  ClientEvent,
  SeriesState,
  Team,
} from "../../../shared/types";

export interface AgentThinking {
  agentId: string;
  agentName: string;
  content: string;
}

interface UseGameSocketReturn {
  gameState: GameState | null;
  gameConfig: GameConfig | null;
  messages: { white: BoardMessage[]; black: BoardMessage[] };
  agentStreams: Record<string, AgentThinking>;
  connected: boolean;
  activeAgentId: string | null;
  activeAgentName: string | null;
  evalScore: { score: number; mate: number | null } | null;
  subscribe: (gameId: string) => void;
  subscribeSeries: (seriesId: string) => void;
}

function dedupeMessages(msgs: BoardMessage[]): BoardMessage[] {
  const seen = new Set<string>();
  return msgs.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

export function useGameSocket(
  onSeriesState?: (state: SeriesState) => void
): UseGameSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const gameIdRef = useRef<string | null>(null);
  const seriesIdRef = useRef<string | null>(null);
  const currentTurnRef = useRef<Team>("white");

  const [gameState, setGameState] = useState<GameState | null>(null);
  const [messages, setMessages] = useState<{
    white: BoardMessage[];
    black: BoardMessage[];
  }>({ white: [], black: [] });
  const [agentStreams, setAgentStreams] = useState<
    Record<string, AgentThinking>
  >({});
  const [gameConfig, setGameConfig] = useState<GameConfig | null>(null);
  const [connected, setConnected] = useState(false);
  const [evalScore, setEvalScore] = useState<{ score: number; mate: number | null } | null>(null);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeAgentName, setActiveAgentName] = useState<string | null>(null);

  const send = useCallback((event: ClientEvent) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(event));
    }
  }, []);

  const handleEvent = useCallback((event: ServerEvent) => {
    switch (event.type) {
      case "game:state": {
        const state = event.payload;
        currentTurnRef.current = state.currentTurn;
        setGameState(state);

        // Only rebuild messages for a fresh game (turn 1, no history yet in our state)
        // This avoids wiping incremental updates mid-game
        const white: BoardMessage[] = [];
        const black: BoardMessage[] = [];
        for (const move of state.moveHistory) {
          if (move.team === "white") {
            white.push(...move.deliberation.messages);
          } else {
            black.push(...move.deliberation.messages);
          }
        }
        if (state.deliberation) {
          const currentMsgs = state.deliberation.messages;
          if (state.deliberation.team === "white") {
            white.push(...currentMsgs);
          } else {
            black.push(...currentMsgs);
          }
        }
        setMessages({ white: dedupeMessages(white), black: dedupeMessages(black) });

        // Only clear streams on new game, not on every state update
        if (state.turnNumber === 1 && state.moveHistory.length === 0) {
          setAgentStreams({});
        }
        break;
      }

      case "game:phase": {
        setGameState((prev) => {
          if (!prev) return prev;
          return { ...prev, phase: event.payload.phase };
        });
        if (event.payload.phase === "deliberation" && event.payload.team) {
          currentTurnRef.current = event.payload.team;
          setActiveAgentId(null);
          setActiveAgentName(null);
        }
        break;
      }

      case "deliberation:message": {
        const msg = event.payload;
        const team = currentTurnRef.current;
        setMessages((prev) => {
          if (prev[team].some((m) => m.id === msg.id)) return prev;
          return {
            ...prev,
            [team]: [...prev[team], msg],
          };
        });
        setGameState((prev) => {
          if (!prev || !prev.deliberation) return prev;
          if (prev.deliberation.messages.some((m) => m.id === msg.id)) return prev;
          return {
            ...prev,
            deliberation: {
              ...prev.deliberation,
              messages: [...prev.deliberation.messages, msg],
            },
          };
        });
        break;
      }

      case "deliberation:active_agent": {
        setActiveAgentId(event.payload.agentId);
        setActiveAgentName(event.payload.agentName);
        setGameState((prev) => {
          if (!prev || !prev.deliberation) return prev;
          return {
            ...prev,
            deliberation: {
              ...prev.deliberation,
              activeAgentId: event.payload.agentId,
            },
          };
        });
        break;
      }

      case "clock:tick": {
        setGameState((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            clockWhite: event.payload.clockWhite,
            clockBlack: event.payload.clockBlack,
          };
        });
        break;
      }

      case "move:submitted": {
        const move = event.payload;
        const nextTurn: Team = move.team === "white" ? "black" : "white";
        currentTurnRef.current = nextTurn;
        setGameState((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            fen: move.fen,
            moveHistory: [...prev.moveHistory, move],
            turnNumber: move.turnNumber + 1,
            currentTurn: nextTurn,
            phase: "deliberation",
            deliberation: null,
          };
        });
        setActiveAgentId(null);
        setActiveAgentName(null);
        break;
      }

      case "game:complete": {
        setGameState((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            phase: "complete",
            winner: event.payload.winner,
          };
        });
        setActiveAgentId(null);
        setActiveAgentName(null);
        break;
      }

      case "agent:thinking": {
        setAgentStreams((prev) => {
          const existing = prev[event.payload.agentId];
          return {
            ...prev,
            [event.payload.agentId]: {
              agentId: event.payload.agentId,
              agentName: event.payload.agentName,
              content: (existing?.content || "") + event.payload.content,
            },
          };
        });
        break;
      }

      case "game:config": {
        setGameConfig(event.payload);
        break;
      }

      case "series:state": {
        onSeriesState?.(event.payload);
        break;
      }

      case "eval:update": {
        setEvalScore(event.payload);
        break;
      }

      case "notepad:updated": {
        break;
      }
    }
  }, [onSeriesState]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket("ws://localhost:3001");
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      if (seriesIdRef.current) {
        ws.send(JSON.stringify({
          type: "series:subscribe",
          payload: { seriesId: seriesIdRef.current },
        }));
      } else if (gameIdRef.current) {
        ws.send(JSON.stringify({
          type: "game:subscribe",
          payload: { gameId: gameIdRef.current },
        }));
      }
    };

    ws.onclose = () => {
      setConnected(false);
      reconnectTimerRef.current = setTimeout(() => connect(), 2000);
    };

    ws.onerror = () => ws.close();

    ws.onmessage = (ev) => {
      try {
        const serverEvent: ServerEvent = JSON.parse(ev.data);
        handleEvent(serverEvent);
      } catch {
        // ignore malformed
      }
    };
  }, [handleEvent]);

  const subscribe = useCallback(
    (gameId: string) => {
      gameIdRef.current = gameId;
      seriesIdRef.current = null;
      setMessages({ white: [], black: [] });
      setAgentStreams({});
      setGameState(null);
      setActiveAgentId(null);
      setActiveAgentName(null);
      send({ type: "game:subscribe", payload: { gameId } });
    },
    [send]
  );

  const subscribeSeries = useCallback(
    (seriesId: string) => {
      seriesIdRef.current = seriesId;
      gameIdRef.current = null;
      setMessages({ white: [], black: [] });
      setAgentStreams({});
      setGameState(null);
      setActiveAgentId(null);
      setActiveAgentName(null);
      send({ type: "series:subscribe", payload: { seriesId } });
    },
    [send]
  );

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return {
    gameState,
    gameConfig,
    messages,
    agentStreams,
    connected,
    activeAgentId,
    activeAgentName,
    evalScore,
    subscribe,
    subscribeSeries,
  };
}
