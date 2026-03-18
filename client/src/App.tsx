import { useState, useCallback, useMemo } from "react";
import { useGameSocket } from "./hooks/useGameSocket";
import GameHeader from "./components/GameHeader";
import ChessBoard from "./components/ChessBoard";
import MessageBoard from "./components/MessageBoard";
import AgentStream from "./components/AgentStream";
import MoveHistory from "./components/MoveHistory";
import type { AgentConfig, GameConfig } from "../../shared/types";

type View = "lobby" | "game";

export default function App() {
  const [view, setView] = useState<View>("lobby");
  const [gameId, setGameId] = useState<string | null>(null);
  const [gameConfig, setGameConfig] = useState<GameConfig | null>(null);
  const [loading, setLoading] = useState(false);

  const { gameState, messages, agentStreams, connected, remainingSec, subscribe } =
    useGameSocket();

  const handleNewGame = useCallback(async () => {
    setLoading(true);
    try {
      // Create a game
      const createRes = await fetch("/api/games", { method: "POST" });
      if (!createRes.ok) throw new Error("Failed to create game");
      const { gameId: id, config } = await createRes.json() as { gameId: string; config: GameConfig };

      setGameConfig(config);
      setGameId(id);
      subscribe(id);

      // Start the game
      const startRes = await fetch(`/api/games/${id}/start`, {
        method: "POST",
      });
      if (!startRes.ok) throw new Error("Failed to start game");

      setView("game");
    } catch (err) {
      console.error("Error creating game:", err);
      alert("Failed to create game. Is the server running on port 3001?");
    } finally {
      setLoading(false);
    }
  }, [subscribe]);

  const handleBack = useCallback(() => {
    setView("lobby");
    setGameId(null);
    setGameConfig(null);
  }, []);

  // Collect all agents from the config
  const allAgents = useMemo<AgentConfig[]>(() => {
    if (!gameConfig) return [];
    return [...gameConfig.white.agents, ...gameConfig.black.agents];
  }, [gameConfig]);

  const whiteAgents = useMemo(
    () => gameConfig?.white.agents ?? [],
    [gameConfig]
  );
  const blackAgents = useMemo(
    () => gameConfig?.black.agents ?? [],
    [gameConfig]
  );

  const selectedMoverId = gameState?.deliberation?.selectedAgentId ?? null;

  if (view === "lobby") {
    return (
      <div className="app">
        <div className="lobby">
          <h1 className="lobby-title">AGENT CHESS LAB</h1>
          <p className="lobby-subtitle">
            Multi-agent deliberation chess experiment
          </p>
          <button
            className="btn-primary"
            onClick={handleNewGame}
            disabled={loading}
          >
            {loading ? "CREATING..." : "NEW GAME"}
          </button>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          >
            <span
              className={`connection-dot ${connected ? "connection-dot--connected" : "connection-dot--disconnected"}`}
            />
            {connected ? "Server connected" : "Server disconnected"}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <GameHeader
        gameState={gameState}
        connected={connected}
        remainingSec={remainingSec}
        onBack={handleBack}
      />
      <div className="game-view">
        <div className="game-main">
          {/* Left panel — Black team messages */}
          <div className="game-main__side-panel">
            <MessageBoard
              team="black"
              messages={messages.black}
              agents={blackAgents}
            />
          </div>

          {/* Center — Chess board */}
          <div className="game-main__center">
            {gameState ? (
              <ChessBoard gameState={gameState} />
            ) : (
              <div
                style={{
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 14,
                }}
              >
                Loading game state...
              </div>
            )}
          </div>

          {/* Right panel — White team messages */}
          <div className="game-main__side-panel game-main__side-panel--right">
            <MessageBoard
              team="white"
              messages={messages.white}
              agents={whiteAgents}
            />
          </div>
        </div>

        {/* Bottom section — Agent streams + Move history */}
        <div className="game-bottom">
          <div className="game-bottom__streams">
            <AgentStream
              agents={allAgents}
              streams={agentStreams}
              selectedMoverId={selectedMoverId}
            />
          </div>
          <div className="game-bottom__moves">
            <MoveHistory
              moves={gameState?.moveHistory ?? []}
              currentTurnNumber={gameState?.turnNumber ?? 1}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
