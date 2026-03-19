import { useState, useEffect } from "react";
import Markdown from "react-markdown";

interface GameSummary {
  gameNumber: number;
  gameId: string;
  whiteAgents: string[];
  blackAgents: string[];
  winner: string | null;
  totalMoves: number;
  durationMs: number;
  startedAt: string;
}

interface GameDetail extends GameSummary {
  moves: any[];
  postgameMessages: any[];
}

export default function GameHistory() {
  const [games, setGames] = useState<GameSummary[]>([]);
  const [selectedGame, setSelectedGame] = useState<GameDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/games?limit=50")
      .then((r) => r.json())
      .then((data) => { setGames(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleSelect = async (gameNumber: number) => {
    try {
      const res = await fetch(`/api/games/${gameNumber}`);
      const data = await res.json();
      setSelectedGame(data);
    } catch {
      // ignore
    }
  };

  const formatDuration = (ms: number) => {
    const min = Math.floor(ms / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    return `${min}m ${sec}s`;
  };

  if (loading) {
    return <div className="game-history__loading">Loading games...</div>;
  }

  if (selectedGame) {
    return (
      <div className="game-history">
        <div className="game-history__detail-header">
          <button className="game-history__back" onClick={() => setSelectedGame(null)}>
            &larr; All Games
          </button>
          <span className="game-history__detail-title">
            Game {selectedGame.gameNumber}
            <span className={`game-history__result game-history__result--${selectedGame.winner}`}>
              {selectedGame.winner === "draw" ? "Draw" : `${selectedGame.winner} wins`}
            </span>
          </span>
        </div>

        <div className="game-history__detail-body">
          <div className="game-history__teams">
            <div className="game-history__team">
              <span className="game-history__team-label" style={{ color: "var(--white-team)" }}>WHITE</span>
              {selectedGame.whiteAgents.map((a) => (
                <span key={a} className="game-history__agent-tag">{a}</span>
              ))}
            </div>
            <span style={{ color: "var(--text-muted)" }}>vs</span>
            <div className="game-history__team">
              <span className="game-history__team-label" style={{ color: "var(--black-team)" }}>BLACK</span>
              {selectedGame.blackAgents.map((a) => (
                <span key={a} className="game-history__agent-tag">{a}</span>
              ))}
            </div>
          </div>

          <div className="game-history__info">
            {selectedGame.totalMoves} moves &middot; {formatDuration(selectedGame.durationMs)}
          </div>

          {/* Move list */}
          <div className="game-history__section">
            <div className="game-history__section-title">MOVES</div>
            <div className="game-history__moves">
              {selectedGame.moves.map((m: any, i: number) => (
                <span key={i} className={`game-history__move game-history__move--${m.team}`}>
                  {m.team === "white" && <span className="game-history__move-num">{Math.ceil(m.turnNumber / 2)}.</span>}
                  {m.move}
                </span>
              ))}
            </div>
          </div>

          {/* Post-game discussion */}
          {selectedGame.postgameMessages.length > 0 && (
            <div className="game-history__section">
              <div className="game-history__section-title">POST-GAME DISCUSSION</div>
              {selectedGame.postgameMessages.map((m: any) => (
                <div key={m.id} className="game-history__postgame-msg">
                  <span className="game-history__msg-author">{m.agent_name}</span>
                  <div className="message__content"><Markdown>{m.content}</Markdown></div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="game-history">
      <div className="game-history__list">
        {games.length === 0 ? (
          <div className="game-history__empty">No games played yet</div>
        ) : (
          games.map((g) => (
            <button
              key={g.gameNumber}
              className="game-history__item"
              onClick={() => handleSelect(g.gameNumber)}
            >
              <span className="game-history__item-num">#{g.gameNumber}</span>
              <span className="game-history__item-teams">
                {g.whiteAgents.join(", ")} <span style={{ color: "var(--text-muted)" }}>vs</span> {g.blackAgents.join(", ")}
              </span>
              <span className={`game-history__item-result game-history__result--${g.winner}`}>
                {g.winner === "draw" ? "Draw" : `${g.winner} wins`}
              </span>
              <span className="game-history__item-moves">{g.totalMoves} moves</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
