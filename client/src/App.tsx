import { useState, useMemo, useCallback } from "react";
import { useGameSocket } from "./hooks/useGameSocket";
import GameHeader from "./components/GameHeader";
import ChessBoard from "./components/ChessBoard";
import GameFeed from "./components/GameFeed";
import AgentStream from "./components/AgentStream";
import MoveHistory from "./components/MoveHistory";
import AgentProfilePanel from "./components/AgentProfilePanel";
import GameHistory from "./components/GameHistory";
import PlayersView from "./components/PlayersView";
import type { AgentConfig } from "../../shared/types";

type Tab = "live" | "games" | "players";

export default function App() {
  const {
    gameState, gameConfig, arenaState, messages, postGameMessages,
    agentStreams, agentSelections, connected, activeAgentId, activeAgentName,
    evalScore, agentProfiles, requestProfile,
  } = useGameSocket();

  const [activeTab, setActiveTab] = useState<Tab>("live");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const allAgents = useMemo<AgentConfig[]>(() => {
    if (!gameConfig) return [];
    return [...gameConfig.white.agents, ...gameConfig.black.agents];
  }, [gameConfig]);

  const handleAgentClick = useCallback((agentName: string) => {
    setSelectedAgent((prev) => prev === agentName ? null : agentName);
    requestProfile(agentName);
  }, [requestProfile]);

  const selectedProfile = selectedAgent ? agentProfiles[selectedAgent] ?? null : null;
  const selectedAgentConfig = allAgents.find((a) => a.name === selectedAgent);
  const selectedAgentStream = selectedAgentConfig ? agentStreams[selectedAgentConfig.id] : null;

  return (
    <div className="app">
      <GameHeader
        gameState={gameState}
        connected={connected}
        activeAgentName={activeAgentName}
        arenaState={arenaState}
      />

      {/* Tab navigation */}
      <div className="tab-nav">
        <button
          className={`tab-nav__tab ${activeTab === "live" ? "tab-nav__tab--active" : ""}`}
          onClick={() => setActiveTab("live")}
        >
          LIVE
          {gameState && gameState.phase !== "complete" && (
            <span className="tab-nav__live-dot" />
          )}
        </button>
        <button
          className={`tab-nav__tab ${activeTab === "games" ? "tab-nav__tab--active" : ""}`}
          onClick={() => setActiveTab("games")}
        >
          GAMES
          {arenaState && (
            <span className="tab-nav__count">{arenaState.totalGamesPlayed}</span>
          )}
        </button>
        <button
          className={`tab-nav__tab ${activeTab === "players" ? "tab-nav__tab--active" : ""}`}
          onClick={() => setActiveTab("players")}
        >
          PLAYERS
        </button>
      </div>

      {/* Tab content */}
      {activeTab === "live" && (
        <>
          <div className="game-layout">
            <div className="game-layout__left">
              <div className="game-layout__board">
                {gameState ? (
                  <ChessBoard gameState={gameState} evalScore={evalScore} />
                ) : (
                  <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 14, textAlign: "center" }}>
                    <div style={{ fontSize: 16, marginBottom: 8 }}>
                      {connected ? "Setting up next game..." : "Connecting..."}
                    </div>
                    {arenaState && (
                      <div style={{ fontSize: 12 }}>Game {arenaState.currentGameNumber}</div>
                    )}
                  </div>
                )}
              </div>
              <div className="game-layout__moves">
                <MoveHistory
                  moves={gameState?.moveHistory ?? []}
                  currentTurnNumber={gameState?.turnNumber ?? 1}
                />
              </div>
            </div>

            <div className="game-layout__right">
              <GameFeed
                messages={messages}
                postGameMessages={postGameMessages}
                moveHistory={gameState?.moveHistory ?? []}
                agentSelections={agentSelections}
                agents={allAgents}
                activeAgentId={activeAgentId}
                currentTurn={gameState?.currentTurn ?? "white"}
                turnNumber={gameState?.turnNumber ?? 1}
                phase={gameState?.phase ?? "waiting"}
                onAgentClick={handleAgentClick}
              />
            </div>

            {selectedAgent && (
              <div className="game-layout__profile">
                <AgentProfilePanel
                  agentName={selectedAgent}
                  profile={selectedProfile}
                  stream={selectedAgentStream}
                  onClose={() => setSelectedAgent(null)}
                />
              </div>
            )}
          </div>

          <div className="game-layout__bottom">
            <AgentStream
              agents={allAgents}
              streams={agentStreams}
              activeAgentId={activeAgentId}
              onAgentClick={handleAgentClick}
            />
          </div>
        </>
      )}

      {activeTab === "games" && (
        <div className="tab-content">
          <GameHistory />
        </div>
      )}

      {activeTab === "players" && (
        <div className="tab-content">
          <PlayersView />
        </div>
      )}
    </div>
  );
}
