import type { GameState } from "../../../shared/types";

interface GameHeaderProps {
  gameState: GameState | null;
  connected: boolean;
  remainingSec: number | null;
  onBack: () => void;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function getStatusLabel(gameState: GameState): string {
  if (gameState.phase === "complete") {
    if (gameState.winner === "draw") return "DRAW";
    return `${gameState.winner?.toUpperCase()} WINS`;
  }
  if (gameState.phase === "deliberation") return "DELIBERATING";
  if (gameState.phase === "move_selection") return "SELECTING MOVE";
  if (gameState.phase === "waiting") return "WAITING";
  return String(gameState.phase).toUpperCase();
}

function getStatusClass(gameState: GameState): string {
  const base = "game-header__status";
  if (gameState.phase === "complete") return `${base} ${base}--complete`;
  // Simple check detection from FEN is complex; rely on status text
  return base;
}

export default function GameHeader({
  gameState,
  connected,
  remainingSec,
  onBack,
}: GameHeaderProps) {
  const isUrgent = remainingSec !== null && remainingSec <= 10;

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
          <div className="game-header__turn">
            <span
              className={`game-header__turn-dot game-header__turn-dot--${gameState.currentTurn}`}
            />
            Turn {gameState.turnNumber}
            <span style={{ color: "var(--text-muted)" }}>
              {gameState.currentTurn.toUpperCase()}
            </span>
          </div>

          {remainingSec !== null && gameState.phase === "deliberation" && (
            <div
              className={`game-header__timer ${isUrgent ? "game-header__timer--urgent" : ""}`}
              style={{
                color: isUrgent
                  ? undefined
                  : gameState.currentTurn === "white"
                    ? "var(--white-team)"
                    : "var(--black-team)",
              }}
            >
              {formatTime(remainingSec)}
            </div>
          )}

          <span className={getStatusClass(gameState)}>
            {getStatusLabel(gameState)}
          </span>
        </div>
      )}

      <div style={{ width: 160 }} />
    </header>
  );
}
