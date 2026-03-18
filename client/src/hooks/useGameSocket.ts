import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GameState,
  BoardMessage,
  ServerEvent,
  ClientEvent,
  Team,
} from "../../../shared/types";

export interface AgentThinking {
  agentId: string;
  agentName: string;
  content: string;
}

interface UseGameSocketReturn {
  gameState: GameState | null;
  messages: { white: BoardMessage[]; black: BoardMessage[] };
  agentStreams: Record<string, AgentThinking>;
  connected: boolean;
  remainingSec: number | null;
  subscribe: (gameId: string) => void;
}

export function useGameSocket(): UseGameSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const gameIdRef = useRef<string | null>(null);
  const currentTurnRef = useRef<Team>("white");

  const [gameState, setGameState] = useState<GameState | null>(null);
  const [messages, setMessages] = useState<{
    white: BoardMessage[];
    black: BoardMessage[];
  }>({ white: [], black: [] });
  const [agentStreams, setAgentStreams] = useState<
    Record<string, AgentThinking>
  >({});
  const [connected, setConnected] = useState(false);
  const [remainingSec, setRemainingSec] = useState<number | null>(null);

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

        // Rebuild messages from state
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
        setMessages({ white, black });
        setAgentStreams({});
        break;
      }

      case "game:phase": {
        setGameState((prev) => {
          if (!prev) return prev;
          return { ...prev, phase: event.payload.phase };
        });
        if (event.payload.phase === "deliberation") {
          currentTurnRef.current = event.payload.team;
          setAgentStreams({});
        }
        break;
      }

      case "deliberation:message": {
        const msg = event.payload;
        const team = currentTurnRef.current;
        setMessages((prev) => ({
          ...prev,
          [team]: [...prev[team], msg],
        }));
        setGameState((prev) => {
          if (!prev || !prev.deliberation) return prev;
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

      case "deliberation:tick": {
        setRemainingSec(event.payload.remainingSec);
        break;
      }

      case "deliberation:agent_selected": {
        setGameState((prev) => {
          if (!prev || !prev.deliberation) return prev;
          return {
            ...prev,
            deliberation: {
              ...prev.deliberation,
              selectedAgentId: event.payload.agentId,
            },
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
        setRemainingSec(null);
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
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket("ws://localhost:3001");
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      if (gameIdRef.current) {
        ws.send(
          JSON.stringify({
            type: "game:subscribe",
            payload: { gameId: gameIdRef.current },
          })
        );
      }
    };

    ws.onclose = () => {
      setConnected(false);
      reconnectTimerRef.current = setTimeout(() => {
        connect();
      }, 2000);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (ev) => {
      try {
        const serverEvent: ServerEvent = JSON.parse(ev.data);
        handleEvent(serverEvent);
      } catch {
        // ignore malformed messages
      }
    };
  }, [handleEvent]);

  const subscribe = useCallback(
    (gameId: string) => {
      gameIdRef.current = gameId;
      setMessages({ white: [], black: [] });
      setAgentStreams({});
      setRemainingSec(null);
      setGameState(null);
      send({ type: "game:subscribe", payload: { gameId } });
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
    messages,
    agentStreams,
    connected,
    remainingSec,
    subscribe,
  };
}
