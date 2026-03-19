import { useState, useEffect } from "react";

interface AgentData {
  name: string;
  personalityId: string;
  selfDefinition: string;
  strategy: string;
  stats: { wins: number; losses: number; draws: number; totalGames: number };
  recentNotepads: { gameNumber: number; content: string }[];
  notes: { subject: string; content: string }[];
  history?: { gameNumber: number; selfDefinition: string; strategy: string; snapshotAt: string }[];
}

export default function PlayersView() {
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentData | null>(null);

  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then(setAgents)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    fetch(`/api/agents/${selected}`)
      .then((r) => r.json())
      .then(setDetail)
      .catch(() => {});
  }, [selected]);

  const winRate = (s: AgentData["stats"]) =>
    s.totalGames > 0 ? Math.round((s.wins / s.totalGames) * 100) : 0;

  if (detail) {
    return (
      <div className="players-view">
        <button className="game-history__back" onClick={() => setSelected(null)}>
          &larr; All Players
        </button>

        <div className="player-detail">
          <div className="player-detail__header">
            <h2 className="player-detail__name">{detail.name}</h2>
            <div className="player-detail__stats">
              <span className="player-detail__stat player-detail__stat--wins">{detail.stats.wins}W</span>
              <span className="player-detail__stat player-detail__stat--losses">{detail.stats.losses}L</span>
              <span className="player-detail__stat player-detail__stat--draws">{detail.stats.draws}D</span>
              <span className="player-detail__stat">{winRate(detail.stats)}%</span>
            </div>
          </div>

          <div className="player-detail__section">
            <div className="player-detail__label">IDENTITY</div>
            <div className="player-detail__content">{detail.selfDefinition || "Not yet defined"}</div>
          </div>

          <div className="player-detail__section">
            <div className="player-detail__label">STRATEGY</div>
            <div className="player-detail__content">{detail.strategy || "No strategy yet"}</div>
          </div>

          {detail.notes && detail.notes.length > 0 && (
            <div className="player-detail__section">
              <div className="player-detail__label">NOTES ON OTHER PLAYERS</div>
              {detail.notes.map((n) => (
                <div key={n.subject} className="player-detail__note">
                  <span className="player-detail__note-subject">{n.subject}:</span> {n.content}
                </div>
              ))}
            </div>
          )}

          {detail.notepads && detail.notepads.length > 0 && (
            <div className="player-detail__section">
              <div className="player-detail__label">RECENT GAME REFLECTIONS</div>
              {detail.notepads.map((n) => (
                <div key={n.gameNumber} className="player-detail__notepad">
                  <span className="player-detail__notepad-game">Game {n.gameNumber}</span>
                  {n.content}
                </div>
              ))}
            </div>
          )}

          {detail.history && detail.history.length > 0 && (
            <div className="player-detail__section">
              <div className="player-detail__label">EVOLUTION</div>
              {detail.history.map((h, i) => (
                <div key={i} className="player-detail__history">
                  <span className="player-detail__history-game">After Game {h.gameNumber}</span>
                  {h.selfDefinition !== detail.history![Math.max(0, i - 1)]?.selfDefinition && i > 0 && (
                    <div className="player-detail__history-change">
                      Identity: {h.selfDefinition}
                    </div>
                  )}
                  {h.strategy !== detail.history![Math.max(0, i - 1)]?.strategy && i > 0 && (
                    <div className="player-detail__history-change">
                      Strategy: {h.strategy.slice(0, 200)}{h.strategy.length > 200 ? "..." : ""}
                    </div>
                  )}
                  {i === 0 && (
                    <div className="player-detail__history-change">
                      Identity: {h.selfDefinition}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="players-view">
      <div className="players-grid">
        {agents.map((a) => (
          <button
            key={a.name}
            className="player-card"
            onClick={() => setSelected(a.name)}
          >
            <div className="player-card__name">{a.name}</div>
            <div className="player-card__identity">{a.selfDefinition?.slice(0, 80) || a.personalityId}</div>
            <div className="player-card__stats">
              <span className="player-detail__stat player-detail__stat--wins">{a.stats.wins}W</span>
              <span className="player-detail__stat player-detail__stat--losses">{a.stats.losses}L</span>
              <span className="player-detail__stat player-detail__stat--draws">{a.stats.draws}D</span>
              {a.stats.totalGames > 0 && (
                <span className="player-detail__stat">{winRate(a.stats)}%</span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
