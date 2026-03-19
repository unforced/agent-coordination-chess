import { useState, useCallback, useMemo, useEffect } from "react";
import { useGameSocket } from "./hooks/useGameSocket";
import GameHeader from "./components/GameHeader";
import ChessBoard from "./components/ChessBoard";
import GameFeed from "./components/GameFeed";
import AgentStream from "./components/AgentStream";
import MoveHistory from "./components/MoveHistory";
import type { AgentConfig, SeriesState } from "../../shared/types";

type View = "lobby" | "game";

export default function App() {
  const [view, setView] = useState<View>("lobby");
  const [seriesState, setSeriesState] = useState<SeriesState | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkedActive, setCheckedActive] = useState(false);

  const {
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
  } = useGameSocket(setSeriesState);

  // On mount, check if there's an active game/series to rejoin
  useEffect(() => {
    if (checkedActive) return;
    setCheckedActive(true);

    fetch("/api/active")
      .then((res) => res.json())
      .then((data) => {
        if (data.type === "series") {
          subscribeSeries(data.seriesId);
          setView("game");
        } else if (data.type === "game") {
          subscribe(data.gameId);
          setView("game");
        }
      })
      .catch(() => {});
  }, [checkedActive, subscribe, subscribeSeries]);

  const handleNewGame = useCallback(async () => {
    setLoading(true);
    try {
      const createRes = await fetch("/api/games", { method: "POST" });
      if (!createRes.ok) throw new Error("Failed to create game");
      const { gameId: id } = await createRes.json();

      setSeriesState(null);
      subscribe(id);

      const startRes = await fetch(`/api/games/${id}/start`, { method: "POST" });
      if (!startRes.ok) throw new Error("Failed to start game");

      setView("game");
    } catch (err) {
      console.error("Error creating game:", err);
      alert("Failed to create game. Is the server running on port 3001?");
    } finally {
      setLoading(false);
    }
  }, [subscribe]);

  const handleNewSeries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalGames: 3 }),
      });
      if (!res.ok) throw new Error("Failed to create series");
      const { seriesId } = await res.json();

      subscribeSeries(seriesId);
      setView("game");
    } catch (err) {
      console.error("Error creating series:", err);
      alert("Failed to create series. Is the server running on port 3001?");
    } finally {
      setLoading(false);
    }
  }, [subscribeSeries]);

  const handleBack = useCallback(() => {
    setView("lobby");
    setSeriesState(null);
  }, []);

  // Derive agents from game config (works for both single game and series)
  const allAgents = useMemo<AgentConfig[]>(() => {
    if (!gameConfig) return [];
    return [...gameConfig.white.agents, ...gameConfig.black.agents];
  }, [gameConfig]);

  // Show "between games" when in a series and game state is null or complete
  const isBetweenGames = seriesState?.status === "in_progress"
    && (!gameState || (gameState.phase === "complete" && gameState.winner));

  if (view === "lobby") {
    return (
      <div className="app">
        <div className="lobby">
          <h1 className="lobby-title">AGENT CHESS LAB</h1>
          <p className="lobby-subtitle">
            Multi-agent deliberation chess experiment
          </p>
          <div style={{ display: "flex", gap: 16 }}>
            <button
              className="btn-primary"
              onClick={handleNewGame}
              disabled={loading}
            >
              {loading ? "CREATING..." : "SINGLE GAME"}
            </button>
            <button
              className="btn-primary"
              onClick={handleNewSeries}
              disabled={loading}
            >
              {loading ? "CREATING..." : "BEST OF 3"}
            </button>
          </div>
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
        activeAgentName={activeAgentName}
        seriesState={seriesState}
        onBack={handleBack}
      />
      <div className="game-layout">
        <div className="game-layout__left">
          <div className="game-layout__board">
            {gameState ? (
              <ChessBoard gameState={gameState} evalScore={evalScore} />
            ) : isBetweenGames ? (
              <div
                style={{
                  color: "var(--text-secondary)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 14,
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 18, marginBottom: 8 }}>Setting up next game...</div>
                <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                  Game {(seriesState?.currentGameIndex ?? 0) + 1}
                </div>
              </div>
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
          <div className="game-layout__moves">
            <MoveHistory
              moves={gameState?.moveHistory ?? []}
              currentTurnNumber={gameState?.turnNumber ?? 1}
            />
          </div>
        </div>

        <div className="game-layout__right">
          <GameFeed
            messages={messages}
            moveHistory={gameState?.moveHistory ?? []}
            agents={allAgents}
            activeAgentId={activeAgentId}
            currentTurn={gameState?.currentTurn ?? "white"}
            turnNumber={gameState?.turnNumber ?? 1}
            phase={gameState?.phase ?? "waiting"}
          />
        </div>
      </div>

      <div className="game-layout__bottom">
        <AgentStream
          agents={allAgents}
          streams={agentStreams}
          activeAgentId={activeAgentId}
        />
      </div>
    </div>
  );
}
