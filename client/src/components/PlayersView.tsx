import { useState, useEffect } from "react";

interface AgentData {
  name: string;
  personalityId: string;
  memory: string;
  stats: { wins: number; losses: number; draws: number; totalGames: number };
  history?: { gameNumber: number; memory: string; snapshotAt: string }[];
}

export default function PlayersView() {
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentData | null>(null);

  useEffect(() => {
    fetch("/api/agents").then((r) => r.json()).then(setAgents).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    fetch(`/api/agents/${selected}`).then((r) => r.json()).then(setDetail).catch(() => {});
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
              {detail.stats.totalGames > 0 && (
                <span className="player-detail__stat">{winRate(detail.stats)}%</span>
              )}
            </div>
          </div>

          <div className="player-detail__section">
            <div className="player-detail__label">MEMORY ({detail.memory?.length ?? 0}/2000)</div>
            <div className="player-detail__content">{detail.memory || "No memories yet"}</div>
          </div>

          {detail.history && detail.history.length > 0 && (
            <div className="player-detail__section">
              <div className="player-detail__label">MEMORY EVOLUTION</div>
              {detail.history.map((h, i) => {
                const prevMemory = i > 0 ? detail.history![i - 1].memory : "";
                const changed = h.memory !== prevMemory;
                if (!changed && i > 0) return null;
                return (
                  <div key={i} className="player-detail__history">
                    <span className="player-detail__history-game">
                      After Game {h.gameNumber}
                    </span>
                    <div className="player-detail__history-change">
                      {h.memory || "(empty)"}
                    </div>
                  </div>
                );
              }).filter(Boolean)}
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
          <button key={a.name} className="player-card" onClick={() => setSelected(a.name)}>
            <div className="player-card__name">{a.name}</div>
            <div className="player-card__identity">
              {a.memory ? a.memory.slice(0, 100) + (a.memory.length > 100 ? "..." : "") : a.personalityId}
            </div>
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
