import { execFile } from "child_process";
import type { MoveRecord } from "../shared/types.js";

interface PositionEval {
  fen: string;
  score: number; // centipawns from white's perspective, or ±Infinity for mate
  mate: number | null; // mate in N moves, null if not a mate score
  bestMove: string | null;
  depth: number;
}

/**
 * Evaluate a single position with Stockfish.
 * Returns score in centipawns from white's perspective.
 */
export function evaluatePosition(fen: string, depthLimit = 12): Promise<PositionEval> {
  return new Promise((resolve, reject) => {
    const proc = execFile("stockfish", [], { timeout: 10000 }, (err) => {
      if (err && !resolved) reject(err);
    });

    if (!proc.stdin || !proc.stdout) {
      reject(new Error("Failed to spawn stockfish"));
      return;
    }

    let resolved = false;
    let output = "";

    proc.stdout.on("data", (data: Buffer) => {
      output += data.toString();

      // Look for the final bestmove line
      if (output.includes("bestmove")) {
        resolved = true;

        // Parse the last "info depth" line with "score"
        const lines = output.split("\n");
        let score = 0;
        let mate: number | null = null;
        let bestMove: string | null = null;
        let depth = 0;

        for (const line of lines) {
          if (line.startsWith("info depth") && line.includes(" score ")) {
            const depthMatch = line.match(/depth (\d+)/);
            if (depthMatch) depth = parseInt(depthMatch[1]);

            const cpMatch = line.match(/score cp (-?\d+)/);
            if (cpMatch) {
              score = parseInt(cpMatch[1]);
              mate = null;
            }

            const mateMatch = line.match(/score mate (-?\d+)/);
            if (mateMatch) {
              mate = parseInt(mateMatch[1]);
              score = mate > 0 ? 100000 : -100000;
            }
          }

          if (line.startsWith("bestmove")) {
            const bmMatch = line.match(/bestmove (\S+)/);
            if (bmMatch) bestMove = bmMatch[1];
          }
        }

        proc.stdin?.write("quit\n");
        resolve({ fen, score, mate, bestMove, depth });
      }
    });

    proc.stdin.write("uci\n");
    proc.stdin.write("isready\n");
    proc.stdin.write(`position fen ${fen}\n`);
    proc.stdin.write(`go depth ${depthLimit}\n`);
  });
}

/**
 * Analyze a full game and produce a summary of each move's quality.
 */
export interface MoveAnalysis {
  turnNumber: number;
  team: string;
  move: string;
  agentName: string;
  evalBefore: number; // centipawns from white's perspective
  evalAfter: number;
  centipawnLoss: number; // how much the move cost (from the moving side's perspective)
  classification: "brilliant" | "good" | "inaccuracy" | "mistake" | "blunder";
}

function classifyMove(cpLoss: number): MoveAnalysis["classification"] {
  if (cpLoss <= 0) return "brilliant";
  if (cpLoss <= 30) return "good";
  if (cpLoss <= 80) return "inaccuracy";
  if (cpLoss <= 200) return "mistake";
  return "blunder";
}

export async function analyzeGame(
  moves: MoveRecord[],
  startingFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
): Promise<MoveAnalysis[]> {
  if (moves.length === 0) return [];

  const analysis: MoveAnalysis[] = [];

  // Evaluate starting position
  let prevEval = await evaluatePosition(startingFen, 10);

  for (const move of moves) {
    const afterEval = await evaluatePosition(move.fen, 10);

    // Calculate centipawn loss from the moving side's perspective
    const evalBefore = prevEval.score;
    const evalAfter = afterEval.score;

    let cpLoss: number;
    if (move.team === "white") {
      // White wants score to go up; loss = how much it dropped
      cpLoss = Math.max(0, evalBefore - evalAfter);
    } else {
      // Black wants score to go down; loss = how much it rose
      cpLoss = Math.max(0, evalAfter - evalBefore);
    }

    analysis.push({
      turnNumber: move.turnNumber,
      team: move.team,
      move: move.move,
      agentName: move.selectedAgentName,
      evalBefore,
      evalAfter,
      centipawnLoss: cpLoss,
      classification: classifyMove(cpLoss),
    });

    prevEval = afterEval;
  }

  return analysis;
}

/**
 * Produce a human-readable game analysis summary for post-game review.
 */
export function formatAnalysisSummary(
  analysis: MoveAnalysis[],
  team: "white" | "black"
): string {
  const teamMoves = analysis.filter((a) => a.team === team);
  const blunders = teamMoves.filter((a) => a.classification === "blunder");
  const mistakes = teamMoves.filter((a) => a.classification === "mistake");
  const inaccuracies = teamMoves.filter((a) => a.classification === "inaccuracy");
  const avgCpLoss = teamMoves.length > 0
    ? Math.round(teamMoves.reduce((sum, a) => sum + a.centipawnLoss, 0) / teamMoves.length)
    : 0;

  let summary = `GAME ANALYSIS (${team}):\n`;
  summary += `Average centipawn loss: ${avgCpLoss}\n`;
  summary += `Blunders: ${blunders.length}, Mistakes: ${mistakes.length}, Inaccuracies: ${inaccuracies.length}\n`;

  if (blunders.length > 0) {
    summary += `\nBLUNDERS:\n`;
    for (const b of blunders) {
      const evalStr = `eval went from ${b.evalBefore > 0 ? "+" : ""}${(b.evalBefore / 100).toFixed(1)} to ${b.evalAfter > 0 ? "+" : ""}${(b.evalAfter / 100).toFixed(1)}`;
      summary += `- Turn ${b.turnNumber}: ${b.agentName} played ${b.move} (${evalStr}, lost ${b.centipawnLoss}cp)\n`;
    }
  }

  if (mistakes.length > 0) {
    summary += `\nMISTAKES:\n`;
    for (const m of mistakes) {
      summary += `- Turn ${m.turnNumber}: ${m.agentName} played ${m.move} (lost ${m.centipawnLoss}cp)\n`;
    }
  }

  return summary;
}

/**
 * Get current eval for spectators (lightweight, low depth).
 */
export async function getSpectatorEval(fen: string): Promise<{ score: number; mate: number | null }> {
  const result = await evaluatePosition(fen, 8);
  return { score: result.score, mate: result.mate };
}
