import type { GameState, SeriesState } from "../../../shared/types";

interface GameHeaderProps {
  gameState: GameState | null;
  connected: boolean;
  activeAgentName: string | null;
  seriesState: SeriesState | null;
  onBack: () => void;
}

function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function getStatusLabel(gameState: GameState, activeAgentName: string | null): string {
  if (gameState.phase === "post_game_deliberation") {
    return activeAgentName ? `${activeAgentName} reviewing...` : "POST-GAME REVIEW";
  }
  if (gameState.phase === "complete") {
    if (gameState.winner === "draw") return "DRAW";
    return `${gameState.winner?.toUpperCase()} WINS`;
  }
  if (gameState.phase === "deliberation" && activeAgentName) {
    return `${activeAgentName} thinking...`;
  }
  if (gameState.phase === "waiting") return "WAITING";
  return "DELIBERATING";
}

function getSeriesScore(seriesState: SeriesState): string {
  let w = 0, b = 0, d = 0;
  for (const r of seriesState.results) {
    if (r.winner === "white") w++;
    else if (r.winner === "black") b++;
    else d++;
  }
  let score = `W ${w} - ${b} B`;
  if (d > 0) score += ` (${d}D)`;
  return score;
}

export default function GameHeader({
  gameState,
  connected,
  activeAgentName,
  seriesState,
  onBack,
}: GameHeaderProps) {
  const isLowTime = (ms: number) => ms < 60_000;

  return (
    <header className="game-header">
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <button
          onClick={onBack}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 14,
          }}
        >
          &larr;
        </button>
        <span className="game-header__logo">AGENT CHESS LAB</span>
        <span
          className={`connection-dot ${connected ? "connection-dot--connected" : "connection-dot--disconnected"}`}
        />
      </div>

      {gameState && (
        <div className="game-header__center">
          {/* White clock */}
          <div
            className={`game-header__clock ${
              gameState.currentTurn === "white" ? "game-header__clock--active" : ""
            } ${isLowTime(gameState.clockWhite) ? "game-header__clock--low" : ""}`}
            style={{
              borderColor: gameState.currentTurn === "white" ? "var(--white-team)" : "transparent",
              color: gameState.currentTurn === "white" ? "var(--white-team)" : "var(--text-muted)",
            }}
          >
            <span className="game-header__clock-label">W</span>
            {formatClock(gameState.clockWhite)}
          </div>

          {/* Turn info + status */}
          <div className="game-header__turn-info">
            <div className="game-header__turn">
              <span
                className={`game-header__turn-dot game-header__turn-dot--${gameState.currentTurn}`}
              />
              Turn {gameState.turnNumber}
              {seriesState && (
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                  Game {seriesState.currentGameIndex + 1}/{seriesState.results.length + (seriesState.status === "in_progress" ? 1 : 0)}
                </span>
              )}
            </div>
            <span className="game-header__status">
              {getStatusLabel(gameState, activeAgentName)}
            </span>
          </div>

          {/* Black clock */}
          <div
            className={`game-header__clock ${
              gameState.currentTurn === "black" ? "game-header__clock--active" : ""
            } ${isLowTime(gameState.clockBlack) ? "game-header__clock--low" : ""}`}
            style={{
              borderColor: gameState.currentTurn === "black" ? "var(--black-team)" : "transparent",
              color: gameState.currentTurn === "black" ? "var(--black-team)" : "var(--text-muted)",
            }}
          >
            <span className="game-header__clock-label">B</span>
            {formatClock(gameState.clockBlack)}
          </div>
        </div>
      )}

      {/* Series score */}
      <div style={{ width: 160, textAlign: "right" }}>
        {seriesState && seriesState.results.length > 0 && (
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            fontWeight: 700,
            color: "var(--text-secondary)",
          }}>
            {getSeriesScore(seriesState)}
          </span>
        )}
      </div>
    </header>
  );
}
