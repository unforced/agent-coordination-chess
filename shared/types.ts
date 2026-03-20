// ── Models ──────────────────────────────────────────────────────────

export type ClaudeModel = "opus" | "sonnet" | "haiku";

// ── Personalities ───────────────────────────────────────────────────

export type PersonalityId = string;

export interface AgentPersonality {
  id: PersonalityId;
  name: string;
  systemPromptFragment: string;
  model: ClaudeModel;
}

// ── Agents ──────────────────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  name: string;
  model: ClaudeModel;
  team: Team;
  personalityId?: PersonalityId;
}

export type Team = "white" | "black";

export interface TeamConfig {
  agents: AgentConfig[];
}

// ── Agent Persistence ───────────────────────────────────────────────

export interface AgentProfile {
  name: string;
  personalityId: string;
  memory: string;     // unified memory, max 2000 chars
  updatedAt: string;
}

export const MEMORY_LIMIT = 2000;

// ── Game ─────────────────────────────────────────────────────────────

export interface GameConfig {
  id: string;
  gameNumber: number;
  white: TeamConfig;
  black: TeamConfig;
  gameTimeSec: number;
  agentTurnTimeSec: number;
  createdAt: string;
}

export type GamePhase =
  | "waiting"
  | "deliberation"
  | "post_game_reflection"
  | "post_game_discussion"
  | "complete";

export interface GameState {
  gameId: string;
  gameNumber: number;
  fen: string;
  moveHistory: MoveRecord[];
  currentTurn: Team;
  phase: GamePhase;
  turnNumber: number;
  winner: Team | "draw" | null;
  deliberation: DeliberationState | null;
  clockWhite: number;
  clockBlack: number;
}

export interface DeliberationState {
  team: Team;
  startedAt: number;
  messages: BoardMessage[];
  activeAgentId: string | null;
  selectedAgentId: string | null;
  submittedMove: string | null;
}

// ── Message Board ───────────────────────────────────────────────────

export interface BoardMessage {
  id: string;
  agentId: string;
  agentName: string;
  content: string;
  timestamp: number;
  turnNumber: number;
}

// ── Move Record ─────────────────────────────────────────────────────

export interface MoveRecord {
  turnNumber: number;
  team: Team;
  move: string;
  fen: string;
  timestamp: number;
  selectedAgentId: string;
  selectedAgentName: string;
  deliberation: {
    messages: BoardMessage[];
    durationMs: number;
  };
}

// ── Arena State ─────────────────────────────────────────────────────

export interface ArenaState {
  totalGamesPlayed: number;
  currentGameNumber: number;
  currentGameId: string | null;
  status: "running" | "stopped";
}

// ── WebSocket Events ────────────────────────────────────────────────

export type ServerEvent =
  | { type: "game:config"; payload: GameConfig }
  | { type: "game:state"; payload: GameState }
  | { type: "game:phase"; payload: { phase: GamePhase; team?: Team } }
  | { type: "deliberation:message"; payload: BoardMessage }
  | { type: "deliberation:active_agent"; payload: { agentId: string; agentName: string } }
  | { type: "clock:tick"; payload: { clockWhite: number; clockBlack: number } }
  | { type: "move:submitted"; payload: MoveRecord }
  | { type: "game:complete"; payload: { winner: Team | "draw" } }
  | { type: "agent:thinking"; payload: { agentId: string; agentName: string; content: string } }
  | { type: "eval:update"; payload: { score: number; mate: number | null } }
  | { type: "arena:state"; payload: ArenaState }
  | { type: "postgame:message"; payload: BoardMessage }
  | { type: "agent:profile"; payload: AgentProfile };

export type ClientEvent =
  | { type: "game:subscribe"; payload: { gameId: string } }
  | { type: "arena:subscribe" }
  | { type: "agent:get_profile"; payload: { agentName: string } };
