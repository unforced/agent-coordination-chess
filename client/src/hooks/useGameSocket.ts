import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GameState,
  GameConfig,
  BoardMessage,
  ServerEvent,
  ArenaState,
  AgentProfile,
  Team,
} from "../../../shared/types";

export interface AgentThinking {
  agentId: string;
  agentName: string;
  content: string;
}

function dedupeMessages(msgs: BoardMessage[]): BoardMessage[] {
  const seen = new Set<string>();
  return msgs.filter((m) => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
}

export function useGameSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const currentTurnRef = useRef<Team>("white");

  const [gameState, setGameState] = useState<GameState | null>(null);
  const [gameConfig, setGameConfig] = useState<GameConfig | null>(null);
  const [arenaState, setArenaState] = useState<ArenaState | null>(null);
  const [messages, setMessages] = useState<{ white: BoardMessage[]; black: BoardMessage[] }>({ white: [], black: [] });
  const [postGameMessages, setPostGameMessages] = useState<BoardMessage[]>([]);
  const [agentStreams, setAgentStreams] = useState<Record<string, AgentThinking>>({});
  const [connected, setConnected] = useState(false);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeAgentName, setActiveAgentName] = useState<string | null>(null);
  const [evalScore, setEvalScore] = useState<{ score: number; mate: number | null } | null>(null);
  const [agentProfiles, setAgentProfiles] = useState<Record<string, AgentProfile>>({});

  const handleEvent = useCallback((event: ServerEvent) => {
    switch (event.type) {
      case "game:config": {
        setGameConfig(event.payload);
        break;
      }

      case "game:state": {
        const state = event.payload;
        currentTurnRef.current = state.currentTurn;
        setGameState(state);

        const white: BoardMessage[] = [];
        const black: BoardMessage[] = [];
        for (const move of state.moveHistory) {
          (move.team === "white" ? white : black).push(...move.deliberation.messages);
        }
        if (state.deliberation) {
          (state.deliberation.team === "white" ? white : black).push(...state.deliberation.messages);
        }
        setMessages({ white: dedupeMessages(white), black: dedupeMessages(black) });

        if (state.turnNumber === 1 && state.moveHistory.length === 0) {
          setAgentStreams({});
          setPostGameMessages([]);
          setEvalScore(null);
        }
        break;
      }

      case "game:phase": {
        setGameState((prev) => prev ? { ...prev, phase: event.payload.phase } : prev);
        if (event.payload.phase === "deliberation" && event.payload.team) {
          currentTurnRef.current = event.payload.team;
          setActiveAgentId(null);
          setActiveAgentName(null);
        }
        if (event.payload.phase === "post_game_reflection") {
          setPostGameMessages([]);
        }
        break;
      }

      case "deliberation:message": {
        const msg = event.payload;
        const team = currentTurnRef.current;
        setMessages((prev) => {
          if (prev[team].some((m) => m.id === msg.id)) return prev;
          return { ...prev, [team]: [...prev[team], msg] };
        });
        break;
      }

      case "postgame:message": {
        setPostGameMessages((prev) => {
          if (prev.some((m) => m.id === event.payload.id)) return prev;
          return [...prev, event.payload];
        });
        break;
      }

      case "deliberation:active_agent": {
        setActiveAgentId(event.payload.agentId);
        setActiveAgentName(event.payload.agentName);
        break;
      }

      case "clock:tick": {
        setGameState((prev) => prev ? { ...prev, clockWhite: event.payload.clockWhite, clockBlack: event.payload.clockBlack } : prev);
        break;
      }

      case "move:submitted": {
        const move = event.payload;
        const nextTurn: Team = move.team === "white" ? "black" : "white";
        currentTurnRef.current = nextTurn;
        setGameState((prev) => prev ? {
          ...prev, fen: move.fen, moveHistory: [...prev.moveHistory, move],
          turnNumber: move.turnNumber + 1, currentTurn: nextTurn, phase: "deliberation", deliberation: null,
        } : prev);
        setActiveAgentId(null);
        setActiveAgentName(null);
        break;
      }

      case "game:complete": {
        setGameState((prev) => prev ? { ...prev, phase: "complete", winner: event.payload.winner } : prev);
        setActiveAgentId(null);
        setActiveAgentName(null);
        break;
      }

      case "agent:thinking": {
        setAgentStreams((prev) => ({
          ...prev,
          [event.payload.agentId]: {
            agentId: event.payload.agentId,
            agentName: event.payload.agentName,
            content: (prev[event.payload.agentId]?.content || "") + event.payload.content,
          },
        }));
        break;
      }

      case "eval:update": {
        setEvalScore(event.payload);
        break;
      }

      case "arena:state": {
        setArenaState(event.payload);
        break;
      }

      case "agent:profile": {
        setAgentProfiles((prev) => ({ ...prev, [event.payload.name]: event.payload }));
        break;
      }
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsHost = window.location.hostname === "localhost" ? "localhost:3001" : window.location.host;
    const ws = new WebSocket(`${wsProtocol}//${wsHost}`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => { setConnected(false); reconnectTimerRef.current = setTimeout(connect, 2000); };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => { try { handleEvent(JSON.parse(ev.data)); } catch {} };
  }, [handleEvent]);

  const requestProfile = useCallback((agentName: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "agent:get_profile", payload: { agentName } }));
    }
  }, []);

  useEffect(() => {
    connect();
    return () => { if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current); wsRef.current?.close(); };
  }, [connect]);

  return {
    gameState, gameConfig, arenaState, messages, postGameMessages,
    agentStreams, connected, activeAgentId, activeAgentName,
    evalScore, agentProfiles, requestProfile,
  };
}
