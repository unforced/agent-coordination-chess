import { Chess } from "chess.js";

export type GameStatus =
  | "checkmate"
  | "stalemate"
  | "draw"
  | "check"
  | "ongoing";

/**
 * Create a new game and return the starting FEN.
 */
export function createGame(): string {
  const chess = new Chess();
  return chess.fen();
}

/**
 * Check whether a move (in SAN notation) is legal in the given position.
 */
export function validateMove(fen: string, move: string): boolean {
  const chess = new Chess(fen);
  try {
    const result = chess.move(move);
    return result !== null;
  } catch {
    return false;
  }
}

/**
 * Apply a move (SAN) to a position and return the new FEN.
 * Throws if the move is illegal.
 */
export function applyMove(fen: string, move: string): string {
  const chess = new Chess(fen);
  const result = chess.move(move);
  if (!result) {
    throw new Error(`Illegal move: ${move} in position ${fen}`);
  }
  return chess.fen();
}

/**
 * Determine the status of the game from a FEN.
 */
export function getGameStatus(fen: string): GameStatus {
  const chess = new Chess(fen);

  if (chess.isCheckmate()) return "checkmate";
  if (chess.isStalemate()) return "stalemate";
  if (chess.isDraw()) return "draw"; // includes 50-move, insufficient material, threefold
  if (chess.inCheck()) return "check";
  return "ongoing";
}

/**
 * Return all legal moves in SAN notation for the current position.
 */
export function getLegalMoves(fen: string): string[] {
  const chess = new Chess(fen);
  return chess.moves();
}

/**
 * Produce a text representation of the board for agents.
 */
export function boardToAscii(fen: string): string {
  const chess = new Chess(fen);
  return chess.ascii();
}
