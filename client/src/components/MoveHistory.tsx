import type { MoveRecord } from "../../../shared/types";

interface MoveHistoryProps {
  moves: MoveRecord[];
  currentTurnNumber: number;
}

export default function MoveHistory({
  moves,
  currentTurnNumber,
}: MoveHistoryProps) {
  // Group moves into pairs (white + black per turn number)
  const pairs: { turnNumber: number; white?: MoveRecord; black?: MoveRecord }[] =
    [];

  for (const move of moves) {
    const pairIdx = Math.ceil(move.turnNumber / 2) - 1;
    if (!pairs[pairIdx]) {
      pairs[pairIdx] = { turnNumber: pairIdx + 1 };
    }
    if (move.team === "white") {
      pairs[pairIdx].white = move;
    } else {
      pairs[pairIdx].black = move;
    }
  }

  return (
    <div className="panel move-history">
      <div className="panel__header">MOVE HISTORY</div>
      {moves.length === 0 ? (
        <div className="move-history__empty">No moves yet</div>
      ) : (
        <div className="move-history__list">
          {pairs.map((pair) => (
            <div className="move-history__row" key={pair.turnNumber}>
              <span className="move-history__turn-num">
                {pair.turnNumber}.
              </span>

              {pair.white ? (
                <span
                  className={`move-history__move move-history__move--white ${
                    pair.white.turnNumber === currentTurnNumber - 1
                      ? "move-history__move--current"
                      : ""
                  }`}
                  title={`by ${pair.white.selectedAgentName}`}
                >
                  {pair.white.move}
                </span>
              ) : (
                <span className="move-history__move" style={{ opacity: 0.2 }}>
                  ...
                </span>
              )}

              {pair.black ? (
                <span
                  className={`move-history__move move-history__move--black ${
                    pair.black.turnNumber === currentTurnNumber - 1
                      ? "move-history__move--current"
                      : ""
                  }`}
                  title={`by ${pair.black.selectedAgentName}`}
                >
                  {pair.black.move}
                </span>
              ) : moves.length > 0 && pair.white ? (
                <span className="move-history__move" style={{ opacity: 0.2 }}>
                  ...
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
