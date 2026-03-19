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
  AgentProfile,
  SELF_DEFINITION_LIMIT,
  STRATEGY_LIMIT,
  NOTEPAD_LIMIT,
  MAX_NOTEPADS_VISIBLE,
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
  saveAgentProfile,
  loadAgentProfile,
  saveGameNotepad,
  loadRecentNotepads,
  saveGameMoves,
} from "./persistence.js";
import { getPersonality } from "./personalities.js";
import { analyzeGame, formatAnalysisSummary, getSpectatorEval } from "./engine.js";

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
  profile: AgentProfile | null,
  recentNotepads: string[]
): string {
  const teammates = teamAgents
    .filter((a) => a.id !== agent.id)
    .map((a) => a.name)
    .join(", ");

  const isSolo = teamAgents.length === 1;

  let prompt = `You are ${agent.name}, on the ${team} team in a collaborative chess game.

TEAM: ${teamAgents.map((a) => a.name).join(", ")}${teammates ? ` | TEAMMATES: ${teammates}` : ""} | YOU PLAY: ${team.toUpperCase()}

Your memory persists across the entire game. Between games you reflect and learn.`;

  // Self-definition (their evolving identity)
  if (profile?.selfDefinition) {
    prompt += `\n\nWHO YOU ARE:\n${profile.selfDefinition}`;
  }

  // Strategy doc
  if (profile?.strategy) {
    prompt += `\n\nYOUR STRATEGY:\n${profile.strategy}`;
  }

  // Recent game notepads
  if (recentNotepads.length > 0) {
    prompt += `\n\nYOUR RECENT GAME NOTES (newest first):`;
    for (let i = 0; i < recentNotepads.length; i++) {
      prompt += `\n[Game -${i + 1}]: ${recentNotepads[i]}`;
    }
  }

  if (isSolo) {
    prompt += `\n\nYou are playing solo. Submit moves directly with submit_move.`;
  } else {
    prompt += `\n\nHOW IT WORKS:
- Agents take turns speaking one at a time (randomly ordered).
- You see the board, legal moves, clock, and teammate messages in your prompt.
- Tools: post_message (share with team), submit_move (ends the turn).
- You can post AND submit, or just post and let the next teammate decide.`;
  }

  prompt += `\n\nMESSAGES: Keep posted messages SHORT — 1-3 sentences. State your move and reason.`;

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
    : isSolo ? "" : "\n(No messages yet — you're first to speak.)";

  const opening = isFirstEver ? "The game begins! " : `Turn ${turnNumber}. `;
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

function buildReflectionPrompt(
  winner: Team | "draw" | null,
  team: Team,
  profile: AgentProfile,
  engineAnalysis: string
): string {
  const outcome = winner === "draw"
    ? "The game ended in a draw."
    : winner === team
      ? "Your team WON!"
      : "Your team LOST.";

  return `GAME OVER. ${outcome}

${engineAnalysis}

Time to reflect on this game. You have several tools:

1. **write_game_notepad** (required) — Write your reflection on THIS game (max ${NOTEPAD_LIMIT} chars). What happened? What did you learn?

2. **update_strategy** — Update your strategy doc (max ${STRATEGY_LIMIT} chars). Your current strategy:
${profile.strategy || "(empty)"}

3. **update_self_definition** — Update how you define yourself (max ${SELF_DEFINITION_LIMIT} chars). Only change this if your identity has genuinely evolved. Current:
${profile.selfDefinition || "(empty)"}

4. **post_reflection** — Share a message with ALL players (both teams) on the post-game board. Offer feedback, observations, or compliments to teammates and opponents.

Reflect honestly. Write your game notepad and post at least one message to the group.`;
}

function buildDiscussionPrompt(
  postGameMessages: BoardMessage[]
): string {
  const chat = postGameMessages.length > 0
    ? postGameMessages.map((m) => `[${m.agentName}]: ${m.content}`).join("\n")
    : "(No messages)";

  return `All players have shared their reflections. Here's what everyone said:

POST-GAME DISCUSSION:
${chat}

Read your teammates' and opponents' feedback. You may:
- **post_reflection** to respond to others' observations
- **update_strategy** if others' feedback changes your approach
- **update_self_definition** if this discussion shifts how you see yourself

This is your final chance to reflect before the next game begins.`;
}

// ── Orchestrator ─────────────────────────────────────────────────────

export type EventCallback = (event: ServerEvent) => void;

export class GameOrchestrator {
  private config: GameConfig;
  private state: GameState;
  private listeners: Set<EventCallback> = new Set();
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  // Agent profiles loaded at game start
  private profiles: Map<string, AgentProfile> = new Map();

  // Persistent agent sessions within a game
  private agentSessions: Map<string, string> = new Map();
  private lastAgentId: Map<Team, string> = new Map();
  private resolveCompletion: (() => void) | null = null;

  // Post-game shared board
  private postGameMessages: BoardMessage[] = [];

  constructor(config: GameConfig) {
    this.config = config;

    const fen = createGame();
    const clockMs = config.gameTimeSec * 1000;
    this.state = {
      gameId: config.id,
      gameNumber: config.gameNumber,
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

    // Load profiles for all agents
    for (const agent of [...config.white.agents, ...config.black.agents]) {
      const profile = loadAgentProfile(agent.name);
      if (profile) {
        this.profiles.set(agent.name, profile);
      }
    }
  }

  // ── Event system ───────────────────────────────────────────────────

  on(callback: EventCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (e) { console.error("Event listener error:", e); }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────

  getState(): GameState { return { ...this.state }; }
  getConfig(): GameConfig { return this.config; }
  getLog(): MoveRecord[] { return [...this.state.moveHistory]; }

  getResult() {
    return { winner: this.state.winner, totalMoves: this.state.moveHistory.length };
  }

  getProfile(agentName: string): AgentProfile | null {
    return this.profiles.get(agentName) ?? loadAgentProfile(agentName);
  }

  async runToCompletion(): Promise<void> {
    if (this.state.phase !== "waiting") throw new Error("Game already started");
    return new Promise<void>((resolve) => {
      this.resolveCompletion = resolve;
      this.runGameLoop().catch((err) => { console.error("Game loop error:", err); resolve(); });
    });
  }

  stop(): void {
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }
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
      this.emit({ type: "clock:tick", payload: { clockWhite: this.state.clockWhite, clockBlack: this.state.clockBlack } });
    }, 1000);
  }

  private stopClockTicker(): void {
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }
  }

  private pickAgent(agents: AgentConfig[], team: Team): AgentConfig {
    const lastId = this.lastAgentId.get(team);
    const eligible = agents.length > 1 ? agents.filter((a) => a.id !== lastId) : agents;
    const picked = eligible[Math.floor(Math.random() * eligible.length)];
    this.lastAgentId.set(team, picked.id);
    return picked;
  }

  // ── Thinking stream helpers ────────────────────────────────────────

  private emitThinking(agentId: string, agentName: string, content: string): void {
    this.emit({ type: "agent:thinking", payload: { agentId, agentName, content } });
  }

  private streamSdkMessage(msg: any, agent: AgentConfig, logPrefix: string): void {
    if (msg.type === "system" && msg.subtype === "init") {
      const sessionId = msg.session_id;
      if (sessionId) {
        this.agentSessions.set(agent.id, sessionId);
        console.log(`[${logPrefix}] ${agent.name} session: ${sessionId}`);
      }
    }

    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type === "tool_use") {
          const inputStr = JSON.stringify(block.input ?? {});
          console.log(`[${logPrefix}] ${agent.name} → ${block.name}(${inputStr.slice(0, 200)})`);
          this.emitThinking(agent.id, agent.name, `\n── ${block.name} ──\n${inputStr}\n`);
        } else if (block.type === "text" && block.text) {
          console.log(`[${logPrefix}] ${agent.name} → ${block.text.slice(0, 150)}`);
          this.emitThinking(agent.id, agent.name, block.text + "\n");
        }
      }
    }

    if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type === "tool_result") {
          const resultStr = typeof block.content === "string" ? block.content
            : Array.isArray(block.content) ? block.content.map((c: any) => c.text ?? "").join("") : JSON.stringify(block.content ?? "");
          console.log(`[${logPrefix}] ${agent.name} ← ${resultStr.slice(0, 200)}`);
          this.emitThinking(agent.id, agent.name, `← ${resultStr}\n`);
        }
      }
    }

    if (msg.type === "error" || msg.subtype === "error") {
      console.error(`[${logPrefix}] ${agent.name} ERROR:`, JSON.stringify(msg).slice(0, 500));
    }
  }

  // ── Game loop ──────────────────────────────────────────────────────

  private async runGameLoop(): Promise<void> {
    while (true) {
      const status = getGameStatus(this.state.fen);

      if (status === "checkmate") {
        const winner: Team = this.state.currentTurn === "white" ? "black" : "white";
        this.state.phase = "complete"; this.state.winner = winner;
        console.log(`[game] Checkmate — ${winner} wins`);
        this.emit({ type: "game:complete", payload: { winner } });
        this.emit({ type: "game:state", payload: this.getState() });
        break;
      }
      if (status === "stalemate" || status === "draw") {
        this.state.phase = "complete"; this.state.winner = "draw";
        console.log("[game] Draw");
        this.emit({ type: "game:complete", payload: { winner: "draw" } });
        this.emit({ type: "game:state", payload: this.getState() });
        break;
      }
      if (this.isClockExpired(this.state.currentTurn)) {
        const winner: Team = this.state.currentTurn === "white" ? "black" : "white";
        this.state.phase = "complete"; this.state.winner = winner;
        console.log(`[game] Time — ${winner} wins`);
        this.emit({ type: "game:complete", payload: { winner } });
        this.emit({ type: "game:state", payload: this.getState() });
        break;
      }

      await this.runTurn();
    }

    saveGameMoves(this.config.gameNumber, this.getLog());
    await this.runPostGame();
    this.resolveCompletion?.();
  }

  // ── Turn ───────────────────────────────────────────────────────────

  private async runTurn(): Promise<void> {
    const team = this.state.currentTurn;
    const agents = (team === "white" ? this.config.white : this.config.black).agents;
    const legalMoves = getLegalMoves(this.state.fen);
    const isSolo = agents.length === 1;

    const deliberation: DeliberationState = {
      team, startedAt: Date.now(), messages: [],
      activeAgentId: null, selectedAgentId: null, submittedMove: null,
    };

    this.state.phase = "deliberation";
    this.state.deliberation = deliberation;
    this.emit({ type: "game:phase", payload: { phase: "deliberation", team } });
    this.emit({ type: "game:state", payload: this.getState() });
    this.startClockTicker();

    const turnStartClock = this.getTeamClock(team);
    const turnStartTime = Date.now();

    let moveSubmitted: string | null = null;
    let movingAgent: AgentConfig | null = null;

    while (!moveSubmitted) {
      const currentClock = turnStartClock - (Date.now() - turnStartTime);
      if (team === "white") this.state.clockWhite = Math.max(0, currentClock);
      else this.state.clockBlack = Math.max(0, currentClock);

      if (this.getTeamClock(team) <= 0) break;

      const agent = isSolo ? agents[0] : this.pickAgent(agents, team);
      deliberation.activeAgentId = agent.id;
      this.emit({ type: "deliberation:active_agent", payload: { agentId: agent.id, agentName: agent.name } });

      const result = await this.runAgentTurn(agent, agents, team, deliberation, legalMoves, isSolo);

      const nowElapsed = Date.now() - turnStartTime;
      if (team === "white") this.state.clockWhite = Math.max(0, turnStartClock - nowElapsed);
      else this.state.clockBlack = Math.max(0, turnStartClock - nowElapsed);

      if (result) {
        moveSubmitted = result; movingAgent = agent;
        deliberation.selectedAgentId = agent.id; deliberation.submittedMove = result;
      }
    }

    this.stopClockTicker();

    if (!moveSubmitted) {
      moveSubmitted = legalMoves[Math.floor(Math.random() * legalMoves.length)];
      movingAgent = agents[0];
      deliberation.selectedAgentId = movingAgent.id; deliberation.submittedMove = moveSubmitted;
    }

    const newFen = applyMove(this.state.fen, moveSubmitted);
    const moveRecord: MoveRecord = {
      turnNumber: this.state.turnNumber, team, move: moveSubmitted, fen: newFen,
      timestamp: Date.now(), selectedAgentId: movingAgent!.id, selectedAgentName: movingAgent!.name,
      deliberation: { messages: [...deliberation.messages], durationMs: Date.now() - deliberation.startedAt },
    };

    this.state.fen = newFen;
    this.state.moveHistory.push(moveRecord);
    this.state.currentTurn = team === "white" ? "black" : "white";
    this.state.turnNumber++;
    this.state.deliberation = null;

    console.log(`[${team}] ${movingAgent!.name} played ${moveSubmitted} — W:${formatClock(this.state.clockWhite)} B:${formatClock(this.state.clockBlack)}`);
    this.emit({ type: "move:submitted", payload: moveRecord });
    this.emit({ type: "game:state", payload: this.getState() });

    getSpectatorEval(newFen).then((ev) => this.emit({ type: "eval:update", payload: ev })).catch(() => {});
  }

  // ── MCP server for game turns ──────────────────────────────────────

  private createGameServer(
    agent: AgentConfig, team: Team, deliberation: DeliberationState,
    legalMoves: string[], onMove: (m: string) => void, isSolo: boolean
  ) {
    const orchestrator = this;
    const fen = this.state.fen;
    const tools = [];

    if (!isSolo) {
      tools.push(tool("post_message", "Post a message to your team's board.",
        { message: z.string().describe("1-3 sentences") },
        async (args: { message: string }) => {
          const msg: BoardMessage = {
            id: uuidv4(), agentId: agent.id, agentName: agent.name,
            content: args.message, timestamp: Date.now(), turnNumber: orchestrator.state.turnNumber,
          };
          deliberation.messages.push(msg);
          orchestrator.emit({ type: "deliberation:message", payload: msg });
          return { content: [{ type: "text" as const, text: "Posted." }] };
        }
      ));
    }

    tools.push(tool("submit_move", "Submit the team's chess move (SAN notation).",
      { move: z.string().describe("e.g. e4, Nf3, O-O") },
      async (args: { move: string }) => {
        if (validateMove(fen, args.move)) { onMove(args.move); return { content: [{ type: "text" as const, text: `${args.move} submitted!` }] }; }
        return { content: [{ type: "text" as const, text: `Illegal: ${args.move}. Legal: ${legalMoves.join(", ")}` }] };
      }
    ));

    return createSdkMcpServer({ name: `chess-${team}-${agent.name.toLowerCase()}`, tools });
  }

  // ── Agent game turn ────────────────────────────────────────────────

  private async runAgentTurn(
    agent: AgentConfig, teamAgents: AgentConfig[], team: Team,
    deliberation: DeliberationState, legalMoves: string[], isSolo: boolean
  ): Promise<string | null> {
    const existingSessionId = this.agentSessions.get(agent.id);
    const isFirstEver = !existingSessionId;

    let submittedMove: string | null = null;
    const server = this.createGameServer(agent, team, deliberation, legalMoves, (m) => { submittedMove = m; }, isSolo);

    const lastOpponentMove = this.state.moveHistory.length > 0 ? this.state.moveHistory[this.state.moveHistory.length - 1] : null;
    const prompt = buildAgentTurnPrompt(this.state.fen, legalMoves, this.state.turnNumber, lastOpponentMove, deliberation.messages, this.getTeamClock(team), isFirstEver && this.state.turnNumber === 1, isSolo);

    const allowedTools = isSolo ? ["mcp__chess__submit_move"] : ["mcp__chess__post_message", "mcp__chess__submit_move"];

    const profile = this.profiles.get(agent.name) ?? null;
    const recentNotepads = loadRecentNotepads(agent.name, MAX_NOTEPADS_VISIBLE).map((n) => n.content);

    const options = isFirstEver
      ? {
          model: resolveModel(agent.model),
          systemPrompt: buildAgentSystemPrompt(agent, teamAgents, team, profile, recentNotepads),
          mcpServers: { chess: server }, maxTurns: 3, allowedTools, permissionMode: "dontAsk" as const,
        }
      : { resume: existingSessionId, mcpServers: { chess: server }, maxTurns: 3, allowedTools, permissionMode: "dontAsk" as const };

    const agentDeadline = Date.now() + this.config.agentTurnTimeSec * 1000;

    if (isFirstEver) {
      this.emitThinking(agent.id, agent.name, `══ SYSTEM PROMPT ══\n${(options as any).systemPrompt}\n\n`);
    }
    this.emitThinking(agent.id, agent.name, `══ TURN ${this.state.turnNumber} ══\n${prompt}\n\n── RESPONSE ──\n`);

    try {
      for await (const message of query({ prompt, options })) {
        if (submittedMove) break;
        if (Date.now() > agentDeadline || this.isClockExpired(team)) break;
        this.streamSdkMessage(message, agent, team);
      }
    } catch (err: any) { console.error(`[${team}] ${agent.name} error:`, err?.message ?? err); }

    return submittedMove;
  }

  // ── Post-game ──────────────────────────────────────────────────────

  private async runPostGame(): Promise<void> {
    console.log("[postgame] Starting post-game reflection...");

    // Run engine analysis
    let whiteAnalysis = "", blackAnalysis = "";
    try {
      console.log("[postgame] Running Stockfish analysis...");
      const analysis = await analyzeGame(this.state.moveHistory);
      whiteAnalysis = formatAnalysisSummary(analysis, "white");
      blackAnalysis = formatAnalysisSummary(analysis, "black");
    } catch (err) { console.warn("[postgame] Analysis failed:", err); }

    const allAgents = [...this.config.white.agents, ...this.config.black.agents];

    // ── Phase 1: Private reflection + post to board ──────────────
    this.state.phase = "post_game_reflection";
    this.emit({ type: "game:phase", payload: { phase: "post_game_reflection" } });
    this.postGameMessages = [];

    for (const agent of allAgents) {
      const sessionId = this.agentSessions.get(agent.id);
      if (!sessionId) continue;

      const profile = this.profiles.get(agent.name) ?? {
        name: agent.name, personalityId: agent.personalityId ?? "",
        selfDefinition: "", strategy: "", updatedAt: new Date().toISOString(),
      };
      const teamAnalysis = agent.team === "white" ? whiteAnalysis : blackAnalysis;
      const prompt = buildReflectionPrompt(this.state.winner, agent.team, profile, teamAnalysis);

      this.emit({ type: "deliberation:active_agent", payload: { agentId: agent.id, agentName: agent.name } });
      this.emitThinking(agent.id, agent.name, `\n══ POST-GAME REFLECTION ══\n${prompt}\n\n── RESPONSE ──\n`);

      const server = this.createReflectionServer(agent);
      const options = { resume: sessionId, mcpServers: { chess: server }, maxTurns: 3,
        allowedTools: ["mcp__chess__write_game_notepad", "mcp__chess__update_strategy", "mcp__chess__update_self_definition", "mcp__chess__post_reflection"],
        permissionMode: "dontAsk" as const };

      try {
        for await (const message of query({ prompt, options })) {
          this.streamSdkMessage(message, agent, "postgame");
        }
      } catch (err: any) { console.error(`[postgame] ${agent.name} error:`, err?.message ?? err); }

      console.log(`[postgame] ${agent.name} done reflecting.`);
    }

    // ── Phase 2: Read everyone's reflections + respond ───────────
    this.state.phase = "post_game_discussion";
    this.emit({ type: "game:phase", payload: { phase: "post_game_discussion" } });

    const discussionPrompt = buildDiscussionPrompt(this.postGameMessages);

    for (const agent of allAgents) {
      const sessionId = this.agentSessions.get(agent.id);
      if (!sessionId) continue;

      this.emit({ type: "deliberation:active_agent", payload: { agentId: agent.id, agentName: agent.name } });
      this.emitThinking(agent.id, agent.name, `\n══ POST-GAME DISCUSSION ══\n${discussionPrompt}\n\n── RESPONSE ──\n`);

      const server = this.createReflectionServer(agent);
      const options = { resume: sessionId, mcpServers: { chess: server }, maxTurns: 2,
        allowedTools: ["mcp__chess__post_reflection", "mcp__chess__update_strategy", "mcp__chess__update_self_definition"],
        permissionMode: "dontAsk" as const };

      try {
        for await (const message of query({ prompt: discussionPrompt, options })) {
          this.streamSdkMessage(message, agent, "discussion");
        }
      } catch (err: any) { console.error(`[discussion] ${agent.name} error:`, err?.message ?? err); }
    }

    console.log("[postgame] Post-game complete.");
  }

  private createReflectionServer(agent: AgentConfig) {
    const orchestrator = this;
    const gameNumber = this.config.gameNumber;

    const writeNotepad = tool("write_game_notepad", `Write your reflection on this game (max ${NOTEPAD_LIMIT} chars).`,
      { content: z.string().describe("Your reflection on this game") },
      async (args: { content: string }) => {
        const trimmed = args.content.slice(0, NOTEPAD_LIMIT);
        saveGameNotepad(agent.name, { gameNumber, content: trimmed, createdAt: new Date().toISOString() });
        console.log(`[postgame] ${agent.name} wrote notepad (${trimmed.length} chars)`);
        return { content: [{ type: "text" as const, text: "Game notepad saved." }] };
      }
    );

    const updateStrategy = tool("update_strategy", `Update your strategy doc (max ${STRATEGY_LIMIT} chars).`,
      { content: z.string().describe("Your evolving chess strategy") },
      async (args: { content: string }) => {
        const trimmed = args.content.slice(0, STRATEGY_LIMIT);
        const profile = orchestrator.profiles.get(agent.name) ?? {
          name: agent.name, personalityId: agent.personalityId ?? "", selfDefinition: "", strategy: "", updatedAt: "",
        };
        profile.strategy = trimmed; profile.updatedAt = new Date().toISOString();
        orchestrator.profiles.set(agent.name, profile);
        saveAgentProfile(profile);
        orchestrator.emit({ type: "agent:profile", payload: profile });
        console.log(`[postgame] ${agent.name} updated strategy (${trimmed.length} chars)`);
        return { content: [{ type: "text" as const, text: "Strategy updated." }] };
      }
    );

    const updateSelf = tool("update_self_definition", `Update your self-definition (max ${SELF_DEFINITION_LIMIT} chars). Only if your identity has genuinely evolved.`,
      { content: z.string().describe("Who you are as a chess player") },
      async (args: { content: string }) => {
        const trimmed = args.content.slice(0, SELF_DEFINITION_LIMIT);
        const profile = orchestrator.profiles.get(agent.name) ?? {
          name: agent.name, personalityId: agent.personalityId ?? "", selfDefinition: "", strategy: "", updatedAt: "",
        };
        profile.selfDefinition = trimmed; profile.updatedAt = new Date().toISOString();
        orchestrator.profiles.set(agent.name, profile);
        saveAgentProfile(profile);
        orchestrator.emit({ type: "agent:profile", payload: profile });
        console.log(`[postgame] ${agent.name} updated self-definition (${trimmed.length} chars)`);
        return { content: [{ type: "text" as const, text: "Self-definition updated." }] };
      }
    );

    const postReflection = tool("post_reflection", "Share a reflection with all players (both teams).",
      { message: z.string().describe("Your reflection or feedback for the group") },
      async (args: { message: string }) => {
        const msg: BoardMessage = {
          id: uuidv4(), agentId: agent.id, agentName: agent.name,
          content: args.message, timestamp: Date.now(), turnNumber: 0,
        };
        orchestrator.postGameMessages.push(msg);
        orchestrator.emit({ type: "postgame:message", payload: msg });
        console.log(`[postgame] ${agent.name} posted: ${args.message.slice(0, 100)}`);
        return { content: [{ type: "text" as const, text: "Posted to post-game board." }] };
      }
    );

    return createSdkMcpServer({
      name: `chess-reflect-${agent.name.toLowerCase()}`,
      tools: [writeNotepad, updateStrategy, updateSelf, postReflection],
    });
  }
}
