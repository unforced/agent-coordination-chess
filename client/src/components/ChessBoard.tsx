import { useMemo, useRef, useState, useEffect } from "react";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import type { GameState } from "../../../shared/types";

interface ChessBoardProps {
  gameState: GameState;
  evalScore?: { score: number; mate: number | null } | null;
}

function formatEval(score: number, mate: number | null): string {
  if (mate !== null) return `M${Math.abs(mate)}`;
  const pawns = Math.abs(score) / 100;
  return pawns.toFixed(1);
}

export default function ChessBoard({ gameState, evalScore }: ChessBoardProps) {
  const { fen, moveHistory, phase, currentTurn } = gameState;
  const containerRef = useRef<HTMLDivElement>(null);
  const [boardSize, setBoardSize] = useState(400);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const size = Math.floor(Math.min(width - 30, height) - 16); // leave room for eval bar
        setBoardSize(Math.max(200, size));
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const lastMoveHighlight = useMemo(() => {
    if (moveHistory.length === 0) return {};
    const lastMove = moveHistory[moveHistory.length - 1];
    try {
      const prevFen =
        moveHistory.length >= 2
          ? moveHistory[moveHistory.length - 2].fen
          : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
      const chess = new Chess(prevFen);
      const result = chess.move(lastMove.move);
      if (result) {
        return {
          [result.from]: { background: "rgba(255, 255, 0, 0.15)" },
          [result.to]: { background: "rgba(255, 255, 0, 0.25)" },
        };
      }
    } catch {
      // no highlight
    }
    return {};
  }, [moveHistory]);

  const isDeliberation = phase === "deliberation";

  const containerClasses = [
    "chess-board-container",
    isDeliberation && "chess-board-container--deliberation",
    isDeliberation && `chess-board-container--deliberation-${currentTurn}`,
  ]
    .filter(Boolean)
    .join(" ");

  // Eval bar: white percentage (0-100)
  const whitePercent = useMemo(() => {
    if (!evalScore) return 50;
    if (evalScore.mate !== null) {
      return evalScore.mate > 0 ? 95 : 5;
    }
    // Sigmoid-ish: map centipawns to 0-100
    const cp = evalScore.score;
    return Math.round(50 + 50 * (2 / (1 + Math.exp(-cp / 200)) - 1));
  }, [evalScore]);

  return (
    <div className="chess-board-wrapper" ref={containerRef}>
      {/* Eval bar */}
      <div className="eval-bar" style={{ height: boardSize }}>
        <div
          className="eval-bar__white"
          style={{ height: `${whitePercent}%` }}
        />
        <div
          className="eval-bar__black"
          style={{ height: `${100 - whitePercent}%` }}
        />
        {evalScore && (
          <div
            className="eval-bar__label"
            style={{
              top: evalScore.score >= 0 ? 4 : undefined,
              bottom: evalScore.score < 0 ? 4 : undefined,
              color: evalScore.score >= 0 ? "#1a1a26" : "#e8e8ed",
            }}
          >
            {evalScore.score >= 0 ? "+" : "-"}{formatEval(evalScore.score, evalScore.mate)}
          </div>
        )}
      </div>

      <div className={containerClasses}>
        <Chessboard
          id="game-board"
          position={fen}
          boardWidth={boardSize}
          arePiecesDraggable={false}
          customSquareStyles={lastMoveHighlight}
          customDarkSquareStyle={{ backgroundColor: "#2a2a3a" }}
          customLightSquareStyle={{ backgroundColor: "#3d3d50" }}
          customBoardStyle={{
            borderRadius: "8px",
            boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
          }}
        />
      </div>
    </div>
  );
}
