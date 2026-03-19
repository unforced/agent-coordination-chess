import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import {
  GameConfig,
  GameState,
  Team,
  AgentConfig,
  BoardMessage,
  MoveRecord,
  DeliberationState,
  ServerEvent,
  INDIVIDUAL_NOTEPAD_LIMIT,
  TEAM_NOTEPAD_LIMIT,
} from "../shared/types.js";
import {
  createGame,
  validateMove,
  applyMove,
  getGameStatus,
  getLegalMoves,
  boardToAscii,
} from "./game.js";
import {
  saveIndividualNotepad,
  saveTeamNotepad,
  loadIndividualNotepad,
  loadTeamNotepad,
  saveGameMoves,
} from "./persistence.js";
import { getPersonality } from "./personalities.js";
import { analyzeGame, formatAnalysisSummary, getSpectatorEval, type MoveAnalysis } from "./engine.js";

// ── Model mapping ────────────────────────────────────────────────────

const MODEL_MAP: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

function resolveModel(model: string): string {
  return MODEL_MAP[model] ?? model;
}

function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── Prompts ──────────────────────────────────────────────────────────

function buildAgentSystemPrompt(
  agent: AgentConfig,
  teamAgents: AgentConfig[],
  team: Team,
  personalityFragment?: string,
  individualNotepad?: string,
  teamNotepad?: string
): string {
  const teammates = teamAgents
    .filter((a) => a.id !== agent.id)
    .map((a) => a.name)
    .join(", ");

  const isSolo = teamAgents.length === 1;

  let prompt = `You are ${agent.name}, on the ${team} team in a collaborative chess game.

TEAM: ${teamAgents.map((a) => a.name).join(", ")}${teammates ? ` | TEAMMATES: ${teammates}` : ""} | YOU PLAY: ${team.toUpperCase()}

Your memory persists across the entire game.`;

  if (personalityFragment) {
    prompt += `\n\n${personalityFragment}`;
  }

  if (isSolo) {
    prompt += `\n\nYou are playing solo. Each turn you see the board and submit a move directly with submit_move.`;
  } else {
    prompt += `\n\nHOW IT WORKS:
- Each turn, agents on your team take turns speaking one at a time (randomly ordered).
- You see the board, legal moves, clock, and all teammate messages in your prompt.
- You have two tools:
  - post_message: share your analysis or move suggestion with the team
  - submit_move: submit the team's move (ends the turn immediately)
- You can post a message AND submit a move, or just post and let the next teammate decide.
- A game clock counts down for your team — manage time wisely.`;
  }

  prompt += `\n\nMESSAGES:
- Keep your posted messages SHORT — 1-3 sentences max. State your recommended move and a one-line reason.
- If teammates have already converged on a move and you agree, just submit it.
- If time is low, submit a move rather than deliberating further.`;

  if (individualNotepad) {
    prompt += `\n\nYOUR PERSONAL NOTES (from previous games):\n${individualNotepad}`;
  }
  if (teamNotepad) {
    prompt += `\n\nTEAM NOTES (shared with teammates, from previous games):\n${teamNotepad}`;
  }

  return prompt;
}

function buildAgentTurnPrompt(
  fen: string,
  legalMoves: string[],
  turnNumber: number,
  lastOpponentMove: MoveRecord | null,
  messages: BoardMessage[],
  clockRemaining: number,
  isFirstEver: boolean,
  isSolo: boolean
): string {
  const ascii = boardToAscii(fen);
  const clock = formatClock(clockRemaining);

  const lastMoveInfo = lastOpponentMove
    ? `\nOpponent's last move: ${lastOpponentMove.selectedAgentName} played ${lastOpponentMove.move}.`
    : "";

  const messageSection = !isSolo && messages.length > 0
    ? `\nTEAM CHAT THIS TURN:\n${messages.map((m) => `[${m.agentName}]: ${m.content}`).join("\n")}`
    : isSolo
      ? ""
      : "\n(No messages yet this turn — you're first to speak.)";

  const opening = isFirstEver
    ? "The game begins! "
    : `Turn ${turnNumber}. `;

  const action = isSolo
    ? "Submit your move."
    : "Post your suggestion or submit a move (or both). Be brief.";

  return `${opening}It's your team's move.${lastMoveInfo}

BOARD:
\`\`\`
${ascii}
\`\`\`
FEN: ${fen}
LEGAL MOVES: ${legalMoves.join(", ")}
TEAM CLOCK: ${clock} remaining
${messageSection}

${action}`;
}

function buildPostGamePrompt(
  winner: Team | "draw" | null,
  team: Team,
  individualNotepad: string,
  teamNotepad: string,
  engineAnalysis?: string
): string {
  const outcome = winner === "draw"
    ? "The game ended in a draw."
    : winner === team
      ? "Your team WON!"
      : "Your team LOST.";

  let prompt = `GAME OVER. ${outcome}

Reflect on this game. What worked? What didn't? What should you remember for next time?`;

  if (engineAnalysis) {
    prompt += `\n\n${engineAnalysis}`;
  }

  prompt += `\n\nYOUR PERSONAL NOTEPAD (max ${INDIVIDUAL_NOTEPAD_LIMIT} chars, only you see this):
${individualNotepad || "(empty)"}

TEAM NOTEPAD (max ${TEAM_NOTEPAD_LIMIT} chars, shared with teammates):
${teamNotepad || "(empty)"}

Use update_individual_notepad and/or update_team_notepad to save observations for future games. Be concise — character limits are strict. You can update both, one, or neither.`;

  return prompt;
}

// ── Series context ───────────────────────────────────────────────────

export interface SeriesContext {
  seriesId: string;
  gameIndex: number;
}

export interface NotepadState {
  individual: Map<string, string>; // agentName → content
  team: Map<Team, string>; // team → content
}

// ── Orchestrator ─────────────────────────────────────────────────────

export type EventCallback = (event: ServerEvent) => void;

export class GameOrchestrator {
  private config: GameConfig;
  private state: GameState;
  private listeners: Set<EventCallback> = new Set();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private seriesContext: SeriesContext | null;
  private notepads: NotepadState;

  // Persistent agent sessions
  private agentSessions: Map<string, string> = new Map();

  // Track last agent who spoke to avoid repeats
  private lastAgentId: Map<Team, string> = new Map();

  // Completion promise
  private resolveCompletion: (() => void) | null = null;

  constructor(
    config: GameConfig,
    seriesContext?: SeriesContext,
    notepads?: NotepadState
  ) {
    this.config = config;
    this.seriesContext = seriesContext ?? null;
    this.notepads = notepads ?? { individual: new Map(), team: new Map() };

    const fen = createGame();
    const clockMs = config.gameTimeSec * 1000;
    this.state = {
      gameId: config.id,
      fen,
      moveHistory: [],
      currentTurn: "white",
      phase: "waiting",
      turnNumber: 1,
      winner: null,
      deliberation: null,
      clockWhite: clockMs,
      clockBlack: clockMs,
    };
  }

  // ── Event system ───────────────────────────────────────────────────

  on(callback: EventCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error("Event listener error:", e);
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────

  getState(): GameState {
    return { ...this.state };
  }

  getConfig(): GameConfig {
    return this.config;
  }

  getLog(): MoveRecord[] {
    return [...this.state.moveHistory];
  }

  getResult() {
    return {
      winner: this.state.winner,
      totalMoves: this.state.moveHistory.length,
    };
  }

  async start(): Promise<void> {
    if (this.state.phase !== "waiting") {
      throw new Error("Game already started");
    }
    this.runGameLoop().catch((err) => {
      console.error("Game loop error:", err);
    });
  }

  /** Runs the full game + post-game deliberation. Resolves when everything is done. */
  async runToCompletion(): Promise<void> {
    if (this.state.phase !== "waiting") {
      throw new Error("Game already started");
    }
    return new Promise<void>((resolve) => {
      this.resolveCompletion = resolve;
      this.runGameLoop().catch((err) => {
        console.error("Game loop error:", err);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  // ── Clock helpers ──────────────────────────────────────────────────

  private getTeamClock(team: Team): number {
    return team === "white" ? this.state.clockWhite : this.state.clockBlack;
  }

  private isClockExpired(team: Team): boolean {
    return this.getTeamClock(team) <= 0;
  }

  private startClockTicker(): void {
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.tickInterval = setInterval(() => {
      this.emit({
        type: "clock:tick",
        payload: {
          clockWhite: this.state.clockWhite,
          clockBlack: this.state.clockBlack,
        },
      });
    }, 1000);
  }

  private stopClockTicker(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  // ── Agent picker (avoid repeats) ───────────────────────────────────

  private pickAgent(agents: AgentConfig[], team: Team): AgentConfig {
    const lastId = this.lastAgentId.get(team);
    const eligible = agents.length > 1
      ? agents.filter((a) => a.id !== lastId)
      : agents;
    const picked = eligible[Math.floor(Math.random() * eligible.length)];
    this.lastAgentId.set(team, picked.id);
    return picked;
  }

  // ── Game loop ──────────────────────────────────────────────────────

  private async runGameLoop(): Promise<void> {
    while (true) {
      const status = getGameStatus(this.state.fen);

      if (status === "checkmate") {
        const winner: Team = this.state.currentTurn === "white" ? "black" : "white";
        this.state.phase = "complete";
        this.state.winner = winner;
        console.log(`[game] Checkmate — ${winner} wins`);
        this.emit({ type: "game:complete", payload: { winner } });
        this.emit({ type: "game:state", payload: this.getState() });
        break;
      }

      if (status === "stalemate" || status === "draw") {
        this.state.phase = "complete";
        this.state.winner = "draw";
        console.log("[game] Draw");
        this.emit({ type: "game:complete", payload: { winner: "draw" } });
        this.emit({ type: "game:state", payload: this.getState() });
        break;
      }

      if (this.isClockExpired(this.state.currentTurn)) {
        const winner: Team = this.state.currentTurn === "white" ? "black" : "white";
        this.state.phase = "complete";
        this.state.winner = winner;
        console.log(`[game] ${this.state.currentTurn} ran out of time — ${winner} wins`);
        this.emit({ type: "game:complete", payload: { winner } });
        this.emit({ type: "game:state", payload: this.getState() });
        break;
      }

      await this.runTurn();
    }

    // Save game moves
    if (this.seriesContext) {
      saveGameMoves(this.seriesContext.seriesId, this.seriesContext.gameIndex, this.getLog());
    }

    // Post-game deliberation
    if (this.seriesContext) {
      await this.runPostGameDeliberation();
    }

    this.resolveCompletion?.();
  }

  private async runTurn(): Promise<void> {
    const team = this.state.currentTurn;
    const teamConfig = team === "white" ? this.config.white : this.config.black;
    const agents = teamConfig.agents;
    const legalMoves = getLegalMoves(this.state.fen);
    const isSolo = agents.length === 1;

    // ── 1. Set up deliberation state ──────────────────────────────

    const deliberation: DeliberationState = {
      team,
      startedAt: Date.now(),
      messages: [],
      activeAgentId: null,
      selectedAgentId: null,
      submittedMove: null,
    };

    this.state.phase = "deliberation";
    this.state.deliberation = deliberation;

    this.emit({ type: "game:phase", payload: { phase: "deliberation", team } });
    this.emit({ type: "game:state", payload: this.getState() });
    this.startClockTicker();

    const turnStartClock = this.getTeamClock(team);
    const turnStartTime = Date.now();

    // ── 2. Agent turn-taking loop ─────────────────────────────────

    let moveSubmitted: string | null = null;
    let movingAgent: AgentConfig | null = null;

    while (!moveSubmitted) {
      // Update clock
      const currentClock = turnStartClock - (Date.now() - turnStartTime);
      if (team === "white") {
        this.state.clockWhite = Math.max(0, currentClock);
      } else {
        this.state.clockBlack = Math.max(0, currentClock);
      }

      if (this.getTeamClock(team) <= 0) {
        console.log(`[${team}] Clock expired during deliberation`);
        break;
      }

      // Pick next agent (solo: always the same one)
      const agent = isSolo ? agents[0] : this.pickAgent(agents, team);
      deliberation.activeAgentId = agent.id;

      this.emit({
        type: "deliberation:active_agent",
        payload: { agentId: agent.id, agentName: agent.name },
      });

      console.log(`[${team}] ${agent.name}'s turn to speak — clock: ${formatClock(this.getTeamClock(team))}`);

      const result = await this.runAgentTurn(
        agent, agents, team, deliberation, legalMoves, isSolo
      );

      // Update clock after agent finishes
      const nowElapsed = Date.now() - turnStartTime;
      if (team === "white") {
        this.state.clockWhite = Math.max(0, turnStartClock - nowElapsed);
      } else {
        this.state.clockBlack = Math.max(0, turnStartClock - nowElapsed);
      }

      if (result) {
        moveSubmitted = result;
        movingAgent = agent;
        deliberation.selectedAgentId = agent.id;
        deliberation.submittedMove = result;
      }
    }

    this.stopClockTicker();

    // ── 3. Fallback if no move submitted ──────────────────────────

    if (!moveSubmitted) {
      console.warn(`[${team}] No agent submitted a move. Picking random.`);
      moveSubmitted = legalMoves[Math.floor(Math.random() * legalMoves.length)];
      movingAgent = agents[0];
      deliberation.selectedAgentId = movingAgent.id;
      deliberation.submittedMove = moveSubmitted;
    }

    // ── 4. Apply the move ─────────────────────────────────────────

    const newFen = applyMove(this.state.fen, moveSubmitted);
    const moveRecord: MoveRecord = {
      turnNumber: this.state.turnNumber,
      team,
      move: moveSubmitted,
      fen: newFen,
      timestamp: Date.now(),
      selectedAgentId: movingAgent!.id,
      selectedAgentName: movingAgent!.name,
      deliberation: {
        messages: [...deliberation.messages],
        durationMs: Date.now() - deliberation.startedAt,
      },
    };

    this.state.fen = newFen;
    this.state.moveHistory.push(moveRecord);
    this.state.currentTurn = team === "white" ? "black" : "white";
    this.state.turnNumber++;
    this.state.deliberation = null;

    console.log(`[${team}] ${movingAgent!.name} submitted ${moveSubmitted} — clocks W:${formatClock(this.state.clockWhite)} B:${formatClock(this.state.clockBlack)}`);

    this.emit({ type: "move:submitted", payload: moveRecord });
    this.emit({ type: "game:state", payload: this.getState() });

    // Emit spectator eval (async, non-blocking)
    getSpectatorEval(newFen)
      .then((evalResult) => {
        this.emit({ type: "eval:update", payload: evalResult });
      })
      .catch(() => {
        // Stockfish not available, skip
      });
  }

  // ── MCP server for agent turns ────────────────────────────────────

  private createAgentServer(
    agent: AgentConfig,
    team: Team,
    deliberation: DeliberationState,
    legalMoves: string[],
    onMoveSubmitted: (move: string) => void,
    isSolo: boolean
  ) {
    const orchestrator = this;
    const fen = this.state.fen;

    const tools = [];

    if (!isSolo) {
      tools.push(tool(
        "post_message",
        "Post a message to your team's shared message board.",
        { message: z.string().describe("Your chess analysis or move suggestion (1-3 sentences)") },
        async (args: { message: string }) => {
          const msg: BoardMessage = {
            id: uuidv4(),
            agentId: agent.id,
            agentName: agent.name,
            content: args.message,
            timestamp: Date.now(),
            turnNumber: orchestrator.state.turnNumber,
          };

          deliberation.messages.push(msg);
          orchestrator.emit({ type: "deliberation:message", payload: msg });
          console.log(`[${team}] ${agent.name} posted: ${args.message.slice(0, 100)}`);

          return { content: [{ type: "text" as const, text: "Message posted." }] };
        }
      ));
    }

    tools.push(tool(
      "submit_move",
      "Submit the team's chess move. Must be in SAN notation and legal.",
      { move: z.string().describe("Chess move in SAN notation (e.g. e4, Nf3, Bxc6, O-O)") },
      async (args: { move: string }) => {
        if (validateMove(fen, args.move)) {
          onMoveSubmitted(args.move);
          return { content: [{ type: "text" as const, text: `Move ${args.move} submitted!` }] };
        }
        return {
          content: [{
            type: "text" as const,
            text: `Illegal move: ${args.move}. Legal moves: ${legalMoves.join(", ")}`,
          }],
        };
      }
    ));

    return createSdkMcpServer({
      name: `chess-${team}-${agent.name.toLowerCase()}`,
      tools,
    });
  }

  // ── Thinking stream helper ──────────────────────────────────────────
  // Emits the full context stream so spectators can see everything
  // the agent sees and produces.

  private emitThinking(agentId: string, agentName: string, content: string): void {
    this.emit({
      type: "agent:thinking",
      payload: { agentId, agentName, content },
    });
  }

  private streamSdkMessage(
    msg: any,
    agent: AgentConfig,
    team: string,
    logPrefix: string
  ): void {
    // Session init
    if (msg.type === "system" && msg.subtype === "init") {
      const sessionId = msg.session_id;
      if (sessionId) {
        this.agentSessions.set(agent.id, sessionId);
        console.log(`[${logPrefix}] ${agent.name} session created: ${sessionId}`);
      }
    }

    // Assistant message — text and tool calls
    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type === "tool_use") {
          const inputStr = JSON.stringify(block.input ?? {});
          console.log(`[${logPrefix}] ${agent.name} → ${block.name}(${inputStr.slice(0, 200)})`);
          this.emitThinking(agent.id, agent.name,
            `\n── ${block.name} ──\n${inputStr}\n`
          );
        } else if (block.type === "text" && block.text) {
          console.log(`[${logPrefix}] ${agent.name} → text: ${block.text.slice(0, 150)}`);
          this.emitThinking(agent.id, agent.name, block.text + "\n");
        }
      }
    }

    // Tool results (user messages containing tool_result blocks)
    if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type === "tool_result") {
          const resultStr = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c: any) => c.text ?? "").join("")
              : JSON.stringify(block.content ?? "");
          console.log(`[${logPrefix}] ${agent.name} ← result: ${resultStr.slice(0, 200)}`);
          this.emitThinking(agent.id, agent.name,
            `← ${resultStr}\n`
          );
        }
      }
    }

    // Errors
    if (msg.type === "error" || msg.subtype === "error") {
      console.error(`[${logPrefix}] ${agent.name} ERROR:`, JSON.stringify(msg).slice(0, 500));
      this.emitThinking(agent.id, agent.name,
        `\n⚠ ERROR: ${JSON.stringify(msg).slice(0, 300)}\n`
      );
    }
  }

  // ── Single agent turn ──────────────────────────────────────────────

  private async runAgentTurn(
    agent: AgentConfig,
    teamAgents: AgentConfig[],
    team: Team,
    deliberation: DeliberationState,
    legalMoves: string[],
    isSolo: boolean
  ): Promise<string | null> {
    const existingSessionId = this.agentSessions.get(agent.id);
    const isFirstEver = !existingSessionId;

    let submittedMove: string | null = null;
    const server = this.createAgentServer(
      agent, team, deliberation, legalMoves,
      (move) => { submittedMove = move; },
      isSolo
    );

    const lastOpponentMove = this.state.moveHistory.length > 0
      ? this.state.moveHistory[this.state.moveHistory.length - 1]
      : null;

    const prompt = buildAgentTurnPrompt(
      this.state.fen,
      legalMoves,
      this.state.turnNumber,
      lastOpponentMove,
      deliberation.messages,
      this.getTeamClock(team),
      isFirstEver && this.state.turnNumber === 1,
      isSolo
    );

    // Build allowed tools list based on what's available
    const allowedTools = isSolo
      ? ["mcp__chess__submit_move"]
      : ["mcp__chess__post_message", "mcp__chess__submit_move"];

    // Get personality and notepads for system prompt
    const personality = agent.personalityId
      ? getPersonality(agent.personalityId).systemPromptFragment
      : undefined;
    const individualNotepad = this.notepads.individual.get(agent.name);
    const teamNotepad = this.notepads.team.get(team);

    const options = isFirstEver
      ? {
          model: resolveModel(agent.model),
          systemPrompt: buildAgentSystemPrompt(
            agent, teamAgents, team, personality, individualNotepad, teamNotepad
          ),
          mcpServers: { chess: server },
          maxTurns: 3,
          allowedTools,
          permissionMode: "dontAsk" as const,
        }
      : {
          resume: existingSessionId,
          mcpServers: { chess: server },
          maxTurns: 3,
          allowedTools,
          permissionMode: "dontAsk" as const,
        };

    const agentDeadline = Date.now() + this.config.agentTurnTimeSec * 1000;

    // Emit the full context the agent receives
    if (isFirstEver) {
      const sysPrompt = buildAgentSystemPrompt(
        agent, teamAgents, team, personality, individualNotepad, teamNotepad
      );
      this.emitThinking(agent.id, agent.name,
        `══ SYSTEM PROMPT ══\n${sysPrompt}\n\n`
      );
    }
    this.emitThinking(agent.id, agent.name,
      `══ TURN ${this.state.turnNumber} PROMPT ══\n${prompt}\n\n── RESPONSE ──\n`
    );

    try {
      for await (const message of query({ prompt, options })) {
        if (submittedMove) break;
        if (Date.now() > agentDeadline) {
          console.log(`[${team}] ${agent.name} hit per-agent time limit`);
          break;
        }
        if (this.isClockExpired(team)) break;

        this.streamSdkMessage(message, agent, team, team);
      }
    } catch (err: any) {
      console.error(`[${team}] ${agent.name} error:`, err?.message ?? err);
    }

    if (submittedMove) {
      console.log(`[${team}] ${agent.name} submitted move: ${submittedMove}`);
    } else {
      console.log(`[${team}] ${agent.name} finished speaking (no move submitted)`);
    }

    return submittedMove;
  }

  // ── Post-game deliberation ─────────────────────────────────────────

  private async runPostGameDeliberation(): Promise<void> {
    if (!this.seriesContext) return;

    console.log("[debrief] Starting post-game deliberation...");
    this.state.phase = "post_game_deliberation";
    this.emit({ type: "game:phase", payload: { phase: "post_game_deliberation" } });

    // Run engine analysis on the full game
    let whiteAnalysis = "";
    let blackAnalysis = "";
    try {
      console.log("[debrief] Running Stockfish analysis...");
      const analysis = await analyzeGame(this.state.moveHistory);
      whiteAnalysis = formatAnalysisSummary(analysis, "white");
      blackAnalysis = formatAnalysisSummary(analysis, "black");
      console.log("[debrief] Analysis complete.");
    } catch (err) {
      console.warn("[debrief] Engine analysis failed, continuing without it:", err);
    }

    const allAgents = [
      ...this.config.white.agents,
      ...this.config.black.agents,
    ];

    for (const agent of allAgents) {
      const team = agent.team;
      const sessionId = this.agentSessions.get(agent.id);
      if (!sessionId) {
        console.warn(`[debrief] No session for ${agent.name}, skipping`);
        continue;
      }

      // Load current notepads (may have been updated by a teammate earlier in this loop)
      const currentIndividual = loadIndividualNotepad(
        this.seriesContext.seriesId, agent.name
      )?.content ?? this.notepads.individual.get(agent.name) ?? "";

      const currentTeam = loadTeamNotepad(
        this.seriesContext.seriesId, team
      )?.content ?? this.notepads.team.get(team) ?? "";

      const teamAnalysis = team === "white" ? whiteAnalysis : blackAnalysis;

      const prompt = buildPostGamePrompt(
        this.state.winner, team, currentIndividual, currentTeam, teamAnalysis
      );

      this.emit({
        type: "deliberation:active_agent",
        payload: { agentId: agent.id, agentName: agent.name },
      });

      console.log(`[debrief] ${agent.name} (${team}) reviewing game...`);

      const server = this.createDebriefServer(agent, team);

      const options = {
        resume: sessionId,
        mcpServers: { chess: server },
        maxTurns: 2,
        allowedTools: [
          "mcp__chess__update_individual_notepad",
          "mcp__chess__update_team_notepad",
        ],
        permissionMode: "dontAsk" as const,
      };

      // Emit the debrief prompt to the thinking stream
      this.emitThinking(agent.id, agent.name,
        `\n══ POST-GAME REVIEW ══\n${prompt}\n\n── RESPONSE ──\n`
      );

      try {
        for await (const message of query({ prompt, options })) {
          this.streamSdkMessage(message, agent, team, "debrief");
        }
      } catch (err: any) {
        console.error(`[debrief] ${agent.name} error:`, err?.message ?? err);
      }

      console.log(`[debrief] ${agent.name} done.`);
    }

    console.log("[debrief] Post-game deliberation complete.");
  }

  private createDebriefServer(agent: AgentConfig, team: Team) {
    const seriesId = this.seriesContext!.seriesId;
    const orchestrator = this;

    const updateIndividualTool = tool(
      "update_individual_notepad",
      `Update your personal notepad (max ${INDIVIDUAL_NOTEPAD_LIMIT} chars). Only you see this across games.`,
      { content: z.string().describe("Your personal notes for future games") },
      async (args: { content: string }) => {
        const trimmed = args.content.slice(0, INDIVIDUAL_NOTEPAD_LIMIT);
        saveIndividualNotepad(seriesId, agent.name, {
          agentName: agent.name,
          content: trimmed,
          updatedAt: new Date().toISOString(),
        });
        orchestrator.notepads.individual.set(agent.name, trimmed);
        orchestrator.emit({
          type: "notepad:updated",
          payload: { agentName: agent.name, team, notepadType: "individual" },
        });
        console.log(`[debrief] ${agent.name} updated individual notepad (${trimmed.length} chars)`);
        return { content: [{ type: "text" as const, text: "Personal notepad updated." }] };
      }
    );

    const updateTeamTool = tool(
      "update_team_notepad",
      `Update the shared team notepad (max ${TEAM_NOTEPAD_LIMIT} chars). All teammates see this.`,
      { content: z.string().describe("Team strategy notes for future games") },
      async (args: { content: string }) => {
        const trimmed = args.content.slice(0, TEAM_NOTEPAD_LIMIT);
        saveTeamNotepad(seriesId, team, {
          team,
          content: trimmed,
          updatedAt: new Date().toISOString(),
        });
        orchestrator.notepads.team.set(team, trimmed);
        orchestrator.emit({
          type: "notepad:updated",
          payload: { agentName: agent.name, team, notepadType: "team" },
        });
        console.log(`[debrief] ${agent.name} updated team notepad (${trimmed.length} chars)`);
        return { content: [{ type: "text" as const, text: "Team notepad updated." }] };
      }
    );

    return createSdkMcpServer({
      name: `chess-debrief-${agent.name.toLowerCase()}`,
      tools: [updateIndividualTool, updateTeamTool],
    });
  }
}
