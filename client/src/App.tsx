import { useState, useMemo, useCallback } from "react";
import { useGameSocket } from "./hooks/useGameSocket";
import GameHeader from "./components/GameHeader";
import ChessBoard from "./components/ChessBoard";
import GameFeed from "./components/GameFeed";
import AgentStream from "./components/AgentStream";
import MoveHistory from "./components/MoveHistory";
import AgentProfilePanel from "./components/AgentProfilePanel";
import type { AgentConfig } from "../../shared/types";

export default function App() {
  const {
    gameState, gameConfig, arenaState, messages, postGameMessages,
    agentStreams, connected, activeAgentId, activeAgentName,
    evalScore, agentProfiles, requestProfile,
  } = useGameSocket();

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

  if (!connected && !gameState) {
    return (
      <div className="app">
        <div className="lobby">
          <h1 className="lobby-title">AGENT CHESS LAB</h1>
          <p className="lobby-subtitle">Connecting to arena...</p>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
            <span className="connection-dot connection-dot--disconnected" />
            Connecting...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <GameHeader
        gameState={gameState}
        connected={connected}
        activeAgentName={activeAgentName}
        arenaState={arenaState}
      />
      <div className="game-layout">
        <div className="game-layout__left">
          <div className="game-layout__board">
            {gameState ? (
              <ChessBoard gameState={gameState} evalScore={evalScore} />
            ) : (
              <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 14, textAlign: "center" }}>
                <div style={{ fontSize: 18, marginBottom: 8 }}>Setting up next game...</div>
                <div style={{ fontSize: 12 }}>Game {arenaState?.currentGameNumber ?? "?"}</div>
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
            agents={allAgents}
            activeAgentId={activeAgentId}
            currentTurn={gameState?.currentTurn ?? "white"}
            turnNumber={gameState?.turnNumber ?? 1}
            phase={gameState?.phase ?? "waiting"}
            onAgentClick={handleAgentClick}
          />
        </div>

        {/* Agent profile sidebar */}
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
    </div>
  );
}
