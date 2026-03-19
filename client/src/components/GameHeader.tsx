import { useState, useEffect, useRef } from "react";
import type { GameState, ArenaState } from "../../../shared/types";

interface GameHeaderProps {
  gameState: GameState | null;
  connected: boolean;
  activeAgentName: string | null;
  arenaState: ArenaState | null;
}

function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function getStatusLabel(gameState: GameState, activeAgentName: string | null): string {
  if (gameState.phase === "post_game_reflection") return activeAgentName ? `${activeAgentName} reflecting...` : "REFLECTING";
  if (gameState.phase === "post_game_discussion") return activeAgentName ? `${activeAgentName} discussing...` : "DISCUSSING";
  if (gameState.phase === "complete") {
    if (gameState.winner === "draw") return "DRAW";
    return `${gameState.winner?.toUpperCase()} WINS`;
  }
  if (gameState.phase === "deliberation" && activeAgentName) return `${activeAgentName} thinking...`;
  if (gameState.phase === "waiting") return "WAITING";
  return "DELIBERATING";
}

// Client-side clock interpolation — counts down smoothly between server ticks
function useInterpolatedClock(serverMs: number, isActive: boolean): number {
  const [displayMs, setDisplayMs] = useState(serverMs);
  const lastServerMs = useRef(serverMs);
  const lastSyncTime = useRef(Date.now());

  // Sync when server sends a new value
  useEffect(() => {
    lastServerMs.current = serverMs;
    lastSyncTime.current = Date.now();
    setDisplayMs(serverMs);
  }, [serverMs]);

  // Client-side countdown at 100ms intervals when active
  useEffect(() => {
    if (!isActive) return;

    const interval = setInterval(() => {
      const elapsed = Date.now() - lastSyncTime.current;
      setDisplayMs(Math.max(0, lastServerMs.current - elapsed));
    }, 100);

    return () => clearInterval(interval);
  }, [isActive]);

  return displayMs;
}

export default function GameHeader({ gameState, connected, activeAgentName, arenaState }: GameHeaderProps) {
  const isLowTime = (ms: number) => ms < 60_000;
  const isWhiteTurn = gameState?.currentTurn === "white" && gameState?.phase === "deliberation";
  const isBlackTurn = gameState?.currentTurn === "black" && gameState?.phase === "deliberation";

  const whiteMs = useInterpolatedClock(gameState?.clockWhite ?? 0, isWhiteTurn);
  const blackMs = useInterpolatedClock(gameState?.clockBlack ?? 0, isBlackTurn);

  return (
    <header className="game-header">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className="game-header__logo">CLAUDE'S GAMBIT</span>
        <span className={`connection-dot ${connected ? "connection-dot--connected" : "connection-dot--disconnected"}`} />
        {arenaState && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)" }}>
            Game {arenaState.currentGameNumber} ({arenaState.totalGamesPlayed} played)
          </span>
        )}
      </div>

      {gameState && (
        <div className="game-header__center">
          <div
            className={`game-header__clock ${isWhiteTurn ? "game-header__clock--active" : ""} ${isLowTime(whiteMs) ? "game-header__clock--low" : ""}`}
            style={{ borderColor: isWhiteTurn ? "var(--white-team)" : "transparent", color: isWhiteTurn ? "var(--white-team)" : "var(--text-muted)" }}
          >
            <span className="game-header__clock-label">W</span>
            {formatClock(whiteMs)}
          </div>

          <div className="game-header__turn-info">
            <div className="game-header__turn">
              <span className={`game-header__turn-dot game-header__turn-dot--${gameState.currentTurn}`} />
              Turn {gameState.turnNumber}
            </div>
            <span className="game-header__status">{getStatusLabel(gameState, activeAgentName)}</span>
          </div>

          <div
            className={`game-header__clock ${isBlackTurn ? "game-header__clock--active" : ""} ${isLowTime(blackMs) ? "game-header__clock--low" : ""}`}
            style={{ borderColor: isBlackTurn ? "var(--black-team)" : "transparent", color: isBlackTurn ? "var(--black-team)" : "var(--text-muted)" }}
          >
            <span className="game-header__clock-label">B</span>
            {formatClock(blackMs)}
          </div>
        </div>
      )}

      <div style={{ width: 120 }} />
    </header>
  );
}
