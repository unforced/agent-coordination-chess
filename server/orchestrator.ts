import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import {
  GameConfig, GameState, Team, AgentConfig, BoardMessage,
  MoveRecord, DeliberationState, ServerEvent, AgentProfile,
  MEMORY_LIMIT,
} from "../shared/types.js";
import {
  createGame, validateMove, applyMove, getGameStatus, getLegalMoves, boardToAscii,
} from "./game.js";
import {
  saveAgentProfile, loadAgentProfile, saveGameRecord,
  savePostgameMessage, snapshotMemory,
} from "./persistence.js";
import { getPersonality } from "./personalities.js";
import { analyzeGame, formatAnalysisSummary, getSpectatorEval } from "./engine.js";

// ── Helpers ──────────────────────────────────────────────────────────

const MODEL_MAP: Record<string, string> = {
  opus: "claude-opus-4-6", sonnet: "claude-sonnet-4-6", haiku: "claude-haiku-4-5",
};
function resolveModel(m: string) { return MODEL_MAP[m] ?? m; }
function formatClock(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

// ── Prompts ──────────────────────────────────────────────────────────

function buildSystemPrompt(
  agent: AgentConfig, teamAgents: AgentConfig[], team: Team, memory: string
): string {
  const teammates = teamAgents.filter((a) => a.id !== agent.id).map((a) => a.name).join(", ");
  const isSolo = teamAgents.length === 1;
  const personality = agent.personalityId ? getPersonality(agent.personalityId).systemPromptFragment : "";

  let p = `You are ${agent.name}, playing ${team.toUpperCase()} in a chess game.
${teammates ? `TEAMMATES: ${teammates}` : "Playing solo."}

${personality}

YOUR MEMORY (${memory.length}/${MEMORY_LIMIT} chars):
${memory || "(empty — you haven't formed any memories yet)"}

HOW THIS WORKS:
- You think carefully using extended thinking, then speak.
- Everything you say out loud is shared with your team${isSolo ? "" : "mates"} on the message board.
- Use your thinking to analyze deeply. Use your words to communicate clearly.
- To make a move, call the submit_move tool.${isSolo ? "" : " Any teammate can submit."}
${isSolo ? "" : `
TEAMWORK:
- Read what your teammates have said and respond to their ideas.
- If a teammate made a mistake last turn, discuss it — help each other improve.
- Build on each other's analysis. Agree, disagree, or refine.
- When the team seems aligned on a move, someone should submit it.
`}
After each game, you'll reflect and can update your memory.
Your memory persists across games — use it to track what you've learned about chess, your teammates, opponents, and strategies that work.`;

  return p;
}

function buildTurnPrompt(
  fen: string, legalMoves: string[], turnNumber: number,
  recentMoves: MoveRecord[], currentMessages: BoardMessage[],
  clockRemaining: number, isFirstEver: boolean, isSolo: boolean
): string {
  const ascii = boardToAscii(fen);

  // Recent game log — last few moves with who played and what teammates discussed
  let gameLog = "";
  const movesToShow = recentMoves.slice(-4); // last 4 moves
  if (movesToShow.length > 0) {
    gameLog = "\nRECENT MOVES:\n";
    for (const m of movesToShow) {
      gameLog += `  ${m.team === "white" ? "W" : "B"} Turn ${m.turnNumber}: ${m.selectedAgentName} played ${m.move}`;
      if (m.deliberation.messages.length > 0) {
        const teamChat = m.deliberation.messages.map((msg) => `${msg.agentName}: ${msg.content}`).join(" | ");
        gameLog += ` [team said: ${teamChat.slice(0, 200)}]`;
      }
      gameLog += "\n";
    }
  }

  // Current turn's discussion so far
  const msgSection = !isSolo && currentMessages.length > 0
    ? `\nTEAM CHAT THIS TURN:\n${currentMessages.map((m) => `[${m.agentName}]: ${m.content}`).join("\n")}` : "";

  return `${isFirstEver ? "Game begins! " : `Turn ${turnNumber}. `}Your team's move.

\`\`\`
${ascii}
\`\`\`
FEN: ${fen}
LEGAL MOVES: ${legalMoves.join(", ")}
CLOCK: ${formatClock(clockRemaining)}
${gameLog}${msgSection}

Your words are shared with your team. Respond to teammates, share your analysis, or suggest a move. If you feel confident, call submit_move — otherwise, contribute your thinking and let the discussion continue.`;
}

function buildReflectionPrompt(
  winner: Team | "draw" | null, team: Team, memory: string, engineAnalysis: string
): string {
  const outcome = winner === "draw" ? "Draw." : winner === team ? "You WON!" : "You LOST.";
  return `GAME OVER. ${outcome}

${engineAnalysis}

YOUR MEMORY (${memory.length}/${MEMORY_LIMIT} chars):
${memory || "(empty)"}

Reflect on this game. Everything you say will be shared with all players.

Then use update_memory to save what you've learned. Your memory carries across all future games — record observations about opponents, teammates, strategies that work, mistakes to avoid. If your memory is getting long, rewrite it more concisely, keeping only the most valuable insights.`;
}

function buildDiscussionPrompt(postGameMessages: BoardMessage[]): string {
  const chat = postGameMessages.map((m) => `[${m.agentName}]: ${m.content}`).join("\n");
  return `Everyone has shared their reflections:

${chat}

Respond to what others said. You can update_memory if their feedback changes your thinking. This is your words will be shared with all players.`;
}

// ── Orchestrator ─────────────────────────────────────────────────────

export type EventCallback = (event: ServerEvent) => void;

export class GameOrchestrator {
  private config: GameConfig;
  private state: GameState;
  private listeners: Set<EventCallback> = new Set();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private profiles: Map<string, AgentProfile> = new Map();
  private agentSessions: Map<string, string> = new Map();
  private lastAgentId: Map<Team, string> = new Map();
  private resolveCompletion: (() => void) | null = null;
  private postGameMessages: BoardMessage[] = [];

  constructor(config: GameConfig) {
    this.config = config;
    const fen = createGame();
    const clockMs = config.gameTimeSec * 1000;
    this.state = {
      gameId: config.id, gameNumber: config.gameNumber, fen,
      moveHistory: [], currentTurn: "white", phase: "waiting",
      turnNumber: 1, winner: null, deliberation: null,
      clockWhite: clockMs, clockBlack: clockMs,
    };
    for (const a of [...config.white.agents, ...config.black.agents]) {
      const p = loadAgentProfile(a.name);
      if (p) this.profiles.set(a.name, p);
    }
  }

  on(cb: EventCallback) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  private emit(e: ServerEvent) { for (const l of this.listeners) { try { l(e); } catch {} } }
  getState(): GameState { return { ...this.state }; }
  getConfig(): GameConfig { return this.config; }
  getLog(): MoveRecord[] { return [...this.state.moveHistory]; }
  getResult() { return { winner: this.state.winner, totalMoves: this.state.moveHistory.length }; }

  getProfile(name: string): AgentProfile | null {
    return this.profiles.get(name) ?? loadAgentProfile(name);
  }

  async runToCompletion(): Promise<void> {
    if (this.state.phase !== "waiting") throw new Error("Already started");
    return new Promise<void>((resolve) => {
      this.resolveCompletion = resolve;
      this.runGameLoop().catch((err) => { console.error("Game loop error:", err); resolve(); });
    });
  }

  stop() { if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; } }

  // ── Clock ──────────────────────────────────────────────────────────

  private getTeamClock(t: Team) { return t === "white" ? this.state.clockWhite : this.state.clockBlack; }
  private isClockExpired(t: Team) { return this.getTeamClock(t) <= 0; }
  private startClockTicker() {
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.tickInterval = setInterval(() => {
      this.emit({ type: "clock:tick", payload: { clockWhite: this.state.clockWhite, clockBlack: this.state.clockBlack } });
    }, 1000);
  }
  private stopClockTicker() { if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; } }

  private pickAgent(agents: AgentConfig[], team: Team): AgentConfig {
    const lastId = this.lastAgentId.get(team);
    const eligible = agents.length > 1 ? agents.filter((a) => a.id !== lastId) : agents;
    const picked = eligible[Math.floor(Math.random() * eligible.length)];
    this.lastAgentId.set(team, picked.id);
    return picked;
  }

  // ── Thinking stream ────────────────────────────────────────────────

  private emitThinking(agentId: string, agentName: string, content: string) {
    this.emit({ type: "agent:thinking", payload: { agentId, agentName, content } });
  }

  /**
   * Process an SDK message. Captures thinking, text, and tool use.
   * Returns any text content from the assistant (to auto-post as message).
   */
  private streamSdkMessage(msg: any, agent: AgentConfig, logPrefix: string): string | null {
    let textContent: string | null = null;

    if (msg.type === "system" && msg.subtype === "init") {
      const sid = msg.session_id;
      if (sid) { this.agentSessions.set(agent.id, sid); console.log(`[${logPrefix}] ${agent.name} session: ${sid}`); }
    }

    if (msg.type !== "system") {
      console.log(`[${logPrefix}] ${agent.name} msg: type=${msg.type} subtype=${msg.subtype ?? "-"}`);
    }

    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type === "thinking" && block.thinking) {
          console.log(`[${logPrefix}] ${agent.name} thinking(${block.thinking.length} chars)`);
          this.emitThinking(agent.id, agent.name, `💭 ${block.thinking}\n\n`);
        } else if (block.type === "tool_use") {
          const input = JSON.stringify(block.input ?? {});
          console.log(`[${logPrefix}] ${agent.name} → ${block.name}(${input.slice(0, 200)})`);
          this.emitThinking(agent.id, agent.name, `── ${block.name} ──\n${input}\n`);
        } else if (block.type === "text" && block.text) {
          console.log(`[${logPrefix}] ${agent.name} says: ${block.text.slice(0, 150)}`);
          this.emitThinking(agent.id, agent.name, `📢 ${block.text}\n\n`);
          textContent = block.text;
        }
      }
    }

    if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type === "tool_result") {
          const r = typeof block.content === "string" ? block.content
            : Array.isArray(block.content) ? block.content.map((c: any) => c.text ?? "").join("") : "";
          this.emitThinking(agent.id, agent.name, `← ${r}\n`);
        }
      }
    }

    if (msg.type === "result") {
      console.log(`[${logPrefix}] ${agent.name} result: subtype=${msg.subtype}`);
    }

    if (msg.type === "error" || msg.subtype === "error") {
      console.error(`[${logPrefix}] ${agent.name} ERROR:`, JSON.stringify(msg).slice(0, 500));
    }

    return textContent;
  }

  // ── Game loop ──────────────────────────────────────────────────────

  private async runGameLoop(): Promise<void> {
    while (true) {
      const status = getGameStatus(this.state.fen);
      if (status === "checkmate") {
        const winner: Team = this.state.currentTurn === "white" ? "black" : "white";
        this.state.phase = "complete"; this.state.winner = winner;
        this.emit({ type: "game:complete", payload: { winner } });
        this.emit({ type: "game:state", payload: this.getState() }); break;
      }
      if (status === "stalemate" || status === "draw") {
        this.state.phase = "complete"; this.state.winner = "draw";
        this.emit({ type: "game:complete", payload: { winner: "draw" } });
        this.emit({ type: "game:state", payload: this.getState() }); break;
      }
      if (this.isClockExpired(this.state.currentTurn)) {
        const winner: Team = this.state.currentTurn === "white" ? "black" : "white";
        this.state.phase = "complete"; this.state.winner = winner;
        this.emit({ type: "game:complete", payload: { winner } });
        this.emit({ type: "game:state", payload: this.getState() }); break;
      }
      await this.runTurn();
    }

    const wa = this.config.white.agents.map((a) => a.name);
    const ba = this.config.black.agents.map((a) => a.name);
    saveGameRecord(this.config.gameNumber, this.config.id, wa, ba,
      this.state.winner, this.state.moveHistory.length,
      Date.now() - (this.state.moveHistory[0]?.timestamp ?? Date.now()),
      this.getLog(), this.config.createdAt);

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
    this.state.phase = "deliberation"; this.state.deliberation = deliberation;
    this.emit({ type: "game:phase", payload: { phase: "deliberation", team } });
    this.emit({ type: "game:state", payload: this.getState() });
    this.startClockTicker();

    const turnStartClock = this.getTeamClock(team);
    const turnStartTime = Date.now();

    let moveSubmitted: string | null = null;
    let movingAgent: AgentConfig | null = null;

    // Agents rotate freely until someone submits or the clock runs out
    while (!moveSubmitted) {
      const elapsed = Date.now() - turnStartTime;
      if (team === "white") this.state.clockWhite = Math.max(0, turnStartClock - elapsed);
      else this.state.clockBlack = Math.max(0, turnStartClock - elapsed);
      if (this.getTeamClock(team) <= 0) break;

      const agent = isSolo ? agents[0] : this.pickAgent(agents, team);
      deliberation.activeAgentId = agent.id;
      this.emit({ type: "deliberation:active_agent", payload: { agentId: agent.id, agentName: agent.name } });

      const result = await this.runAgentTurn(
        agent, agents, team, deliberation, legalMoves, isSolo
      );

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
    }

    const newFen = applyMove(this.state.fen, moveSubmitted);
    const moveRecord: MoveRecord = {
      turnNumber: this.state.turnNumber, team, move: moveSubmitted, fen: newFen,
      timestamp: Date.now(), selectedAgentId: movingAgent!.id, selectedAgentName: movingAgent!.name,
      deliberation: { messages: [...deliberation.messages], durationMs: Date.now() - deliberation.startedAt },
    };
    this.state.fen = newFen; this.state.moveHistory.push(moveRecord);
    this.state.currentTurn = team === "white" ? "black" : "white";
    this.state.turnNumber++; this.state.deliberation = null;

    console.log(`[${team}] ${movingAgent!.name} played ${moveSubmitted} — W:${formatClock(this.state.clockWhite)} B:${formatClock(this.state.clockBlack)}`);
    this.emit({ type: "move:submitted", payload: moveRecord });
    this.emit({ type: "game:state", payload: this.getState() });
    getSpectatorEval(newFen).then((ev) => this.emit({ type: "eval:update", payload: ev })).catch(() => {});
  }

  // ── MCP: game turn (only submit_move) ──────────────────────────────

  private createGameServer(
    legalMoves: string[], onMove: (m: string) => void
  ) {
    const fen = this.state.fen;
    return createSdkMcpServer({
      name: "chess",
      tools: [
        tool("submit_move", "Submit the team's chess move (SAN notation).",
          { move: z.string().describe("e.g. e4, Nf3, O-O") },
          async (args: { move: string }) => {
            if (validateMove(fen, args.move)) { onMove(args.move); return { content: [{ type: "text" as const, text: `${args.move} submitted!` }] }; }
            return { content: [{ type: "text" as const, text: `Illegal: ${args.move}. Legal: ${legalMoves.join(", ")}` }] };
          }
        ),
      ],
    });
  }

  // ── Agent game turn ────────────────────────────────────────────────
  // Text output = auto-posted to team message board

  private async runAgentTurn(
    agent: AgentConfig, teamAgents: AgentConfig[], team: Team,
    deliberation: DeliberationState, legalMoves: string[], isSolo: boolean
  ): Promise<string | null> {
    const existingSessionId = this.agentSessions.get(agent.id);
    const isFirstEver = !existingSessionId;

    let submittedMove: string | null = null;
    const server = this.createGameServer(legalMoves, (m) => { submittedMove = m; });

    const prompt = buildTurnPrompt(this.state.fen, legalMoves, this.state.turnNumber,
      this.state.moveHistory, deliberation.messages, this.getTeamClock(team),
      isFirstEver && this.state.turnNumber === 1, isSolo);

    const memory = this.profiles.get(agent.name)?.memory ?? "";
    const thinkingConfig = { type: "enabled" as const, budgetTokens: 5000 };

    const options = isFirstEver
      ? {
          model: resolveModel(agent.model),
          systemPrompt: buildSystemPrompt(agent, teamAgents, team, memory),
          mcpServers: { chess: server }, maxTurns: 3,
          allowedTools: ["mcp__chess__submit_move"],
          permissionMode: "dontAsk" as const, thinking: thinkingConfig,
        }
      : {
          resume: existingSessionId, mcpServers: { chess: server }, maxTurns: 3,
          allowedTools: ["mcp__chess__submit_move"],
          permissionMode: "dontAsk" as const, thinking: thinkingConfig,
        };

    const agentDeadline = Date.now() + this.config.agentTurnTimeSec * 1000;

    if (isFirstEver) {
      this.emitThinking(agent.id, agent.name, `══ SYSTEM PROMPT ══\n${(options as any).systemPrompt}\n\n`);
    }
    this.emitThinking(agent.id, agent.name, `══ TURN ${this.state.turnNumber} ══\n${prompt}\n\n`);

    try {
      for await (const message of query({ prompt, options })) {
        if (submittedMove) break;
        if (Date.now() > agentDeadline || this.isClockExpired(team)) break;

        const textContent = this.streamSdkMessage(message, agent, team);

        // Auto-post text to team message board
        if (textContent && !isSolo) {
          const msg: BoardMessage = {
            id: uuidv4(), agentId: agent.id, agentName: agent.name,
            content: textContent, timestamp: Date.now(), turnNumber: this.state.turnNumber,
          };
          deliberation.messages.push(msg);
          this.emit({ type: "deliberation:message", payload: msg });
        }
      }
    } catch (err: any) { console.error(`[${team}] ${agent.name} error:`, err?.message ?? err); }

    return submittedMove;
  }

  // ── Post-game ──────────────────────────────────────────────────────

  private async runPostGame(): Promise<void> {
    console.log("[postgame] Starting reflection...");

    let whiteAnalysis = "", blackAnalysis = "";
    try {
      const analysis = await analyzeGame(this.state.moveHistory);
      whiteAnalysis = formatAnalysisSummary(analysis, "white");
      blackAnalysis = formatAnalysisSummary(analysis, "black");
    } catch (err) { console.warn("[postgame] Analysis failed:", err); }

    const allAgents = [...this.config.white.agents, ...this.config.black.agents];

    // ── Phase 1: Private reflection, text auto-shared ────────────
    this.state.phase = "post_game_reflection";
    this.emit({ type: "game:phase", payload: { phase: "post_game_reflection" } });
    this.postGameMessages = [];

    for (const agent of allAgents) {
      const sessionId = this.agentSessions.get(agent.id);
      if (!sessionId) continue;

      const profile = this.profiles.get(agent.name) ?? {
        name: agent.name, personalityId: agent.personalityId ?? "", memory: "", updatedAt: "",
      };
      const analysis = agent.team === "white" ? whiteAnalysis : blackAnalysis;
      const prompt = buildReflectionPrompt(this.state.winner, agent.team, profile.memory, analysis);

      this.emit({ type: "deliberation:active_agent", payload: { agentId: agent.id, agentName: agent.name } });
      this.emitThinking(agent.id, agent.name, `\n══ REFLECTION ══\n${prompt}\n\n`);

      const server = this.createReflectionServer(agent);
      const options = {
        resume: sessionId, mcpServers: { chess: server }, maxTurns: 3,
        allowedTools: ["mcp__chess__update_memory"],
        permissionMode: "dontAsk" as const,
        thinking: { type: "enabled" as const, budgetTokens: 5000 },
      };

      try {
        for await (const message of query({ prompt, options })) {
          const textContent = this.streamSdkMessage(message, agent, "postgame");
          // Auto-post text to shared postgame board
          if (textContent) {
            const msg: BoardMessage = {
              id: uuidv4(), agentId: agent.id, agentName: agent.name,
              content: textContent, timestamp: Date.now(), turnNumber: 0,
            };
            this.postGameMessages.push(msg);
            this.emit({ type: "postgame:message", payload: msg });
            savePostgameMessage(msg.id, this.config.gameNumber, agent.name, textContent, msg.timestamp);
          }
        }
      } catch (err: any) { console.error(`[postgame] ${agent.name} error:`, err?.message ?? err); }
    }

    // ── Phase 2: Discussion — read everyone's reflections ────────
    this.state.phase = "post_game_discussion";
    this.emit({ type: "game:phase", payload: { phase: "post_game_discussion" } });

    const discussionPrompt = buildDiscussionPrompt(this.postGameMessages);

    for (const agent of allAgents) {
      const sessionId = this.agentSessions.get(agent.id);
      if (!sessionId) continue;

      this.emit({ type: "deliberation:active_agent", payload: { agentId: agent.id, agentName: agent.name } });
      this.emitThinking(agent.id, agent.name, `\n══ DISCUSSION ══\n${discussionPrompt}\n\n`);

      const server = this.createReflectionServer(agent);
      const options = {
        resume: sessionId, mcpServers: { chess: server }, maxTurns: 2,
        allowedTools: ["mcp__chess__update_memory"],
        permissionMode: "dontAsk" as const,
        thinking: { type: "enabled" as const, budgetTokens: 3000 },
      };

      try {
        for await (const message of query({ prompt: discussionPrompt, options })) {
          const textContent = this.streamSdkMessage(message, agent, "discussion");
          if (textContent) {
            const msg: BoardMessage = {
              id: uuidv4(), agentId: agent.id, agentName: agent.name,
              content: textContent, timestamp: Date.now(), turnNumber: 0,
            };
            this.postGameMessages.push(msg);
            this.emit({ type: "postgame:message", payload: msg });
            savePostgameMessage(msg.id, this.config.gameNumber, agent.name, textContent, msg.timestamp);
          }
        }
      } catch (err: any) { console.error(`[discussion] ${agent.name} error:`, err?.message ?? err); }
    }

    // Snapshot all memories
    for (const agent of allAgents) {
      snapshotMemory(agent.name, this.config.gameNumber);
    }

    console.log("[postgame] Complete.");
  }

  private createReflectionServer(agent: AgentConfig) {
    const orchestrator = this;
    return createSdkMcpServer({
      name: "chess",
      tools: [
        tool("update_memory",
          `Rewrite your memory (max ${MEMORY_LIMIT} chars). This replaces your entire memory and carries across all future games.`,
          { content: z.string().describe("Your updated memory — insights, strategies, notes on players") },
          async (args: { content: string }) => {
            const trimmed = args.content.slice(0, MEMORY_LIMIT);
            const profile = orchestrator.profiles.get(agent.name) ?? {
              name: agent.name, personalityId: agent.personalityId ?? "", memory: "", updatedAt: "",
            };
            profile.memory = trimmed; profile.updatedAt = new Date().toISOString();
            orchestrator.profiles.set(agent.name, profile);
            saveAgentProfile(profile);
            orchestrator.emit({ type: "agent:profile", payload: profile });
            console.log(`[postgame] ${agent.name} updated memory (${trimmed.length}/${MEMORY_LIMIT} chars)`);
            return { content: [{ type: "text" as const, text: `Memory updated (${trimmed.length}/${MEMORY_LIMIT} chars).` }] };
          }
        ),
      ],
    });
  }
}
