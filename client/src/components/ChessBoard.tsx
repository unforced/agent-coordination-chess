import { useMemo } from "react";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import type { GameState } from "../../../shared/types";

interface ChessBoardProps {
  gameState: GameState;
}

export default function ChessBoard({ gameState }: ChessBoardProps) {
  const { fen, moveHistory, phase, currentTurn } = gameState;

  // Highlight last move squares
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
      // fallback: no highlight
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

  return (
    <div className={containerClasses}>
      <Chessboard
        id="game-board"
        position={fen}
        boardWidth={480}
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
  );
}
