import path from "path";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { ServerEvent, ClientEvent } from "../shared/types.js";
import { startArena, getCurrentOrchestrator, getArenaState, onArenaStateChange } from "./arena.js";
import {
  loadAgentProfile, loadAllAgentProfiles, loadRecentGames,
  loadGameByNumber, loadAgentStats, loadRecentNotepads,
  loadPostgameMessages, loadAllAgentNotes, loadProfileHistory,
} from "./persistence.js";

// ── WebSocket subscribers ────────────────────────────────────────────

const subscribers = new Set<WebSocket>();

function broadcast(event: ServerEvent): void {
  const data = JSON.stringify(event);
  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// ── Express App ──────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const clientDist = path.join(process.cwd(), "client", "dist");
app.use(express.static(clientDist));

// ── API Routes ───────────────────────────────────────────────────────

// Current live state
app.get("/api/state", (_req, res) => {
  const orchestrator = getCurrentOrchestrator();
  const arena = getArenaState();
  res.json({
    arena,
    gameState: orchestrator?.getState() ?? null,
    gameConfig: orchestrator?.getConfig() ?? null,
  });
});

// Agent profiles
app.get("/api/agents", (_req, res) => {
  const profiles = loadAllAgentProfiles();
  const enriched = profiles.map((p) => ({
    ...p,
    stats: loadAgentStats(p.name),
    recentNotepads: loadRecentNotepads(p.name, 5).map((n) => ({
      gameNumber: n.gameNumber,
      content: n.content,
    })),
    notes: loadAllAgentNotes(p.name),
  }));
  res.json(enriched);
});

app.get("/api/agents/:name", (req, res) => {
  const profile = loadAgentProfile(req.params.name);
  if (!profile) { res.status(404).json({ error: "Agent not found" }); return; }

  const stats = loadAgentStats(req.params.name);
  const notepads = loadRecentNotepads(req.params.name, 10);
  const notes = loadAllAgentNotes(req.params.name);

  const history = loadProfileHistory(req.params.name);
  res.json({ ...profile, stats, notepads, notes, history });
});

// Game history
app.get("/api/games", (req, res) => {
  const limit = parseInt(req.query?.limit as string) || 50;
  res.json(loadRecentGames(limit));
});

app.get("/api/games/:number", (req, res) => {
  const gameNumber = parseInt(req.params.number);
  if (isNaN(gameNumber)) { res.status(400).json({ error: "Invalid game number" }); return; }

  const game = loadGameByNumber(gameNumber);
  if (!game) { res.status(404).json({ error: "Game not found" }); return; }

  const postgameMessages = loadPostgameMessages(gameNumber);

  res.json({ ...game, postgameMessages });
});

// SPA fallback (must be last)
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

// ── HTTP + WebSocket Server ──────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3001", 10);
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  subscribers.add(ws);

  const orchestrator = getCurrentOrchestrator();
  const arena = getArenaState();

  ws.send(JSON.stringify({ type: "arena:state", payload: arena } satisfies ServerEvent));

  if (orchestrator) {
    ws.send(JSON.stringify({ type: "game:config", payload: orchestrator.getConfig() } satisfies ServerEvent));
    ws.send(JSON.stringify({ type: "game:state", payload: orchestrator.getState() } satisfies ServerEvent));
  }

  ws.on("message", (raw) => {
    try {
      const event: ClientEvent = JSON.parse(raw.toString());

      if (event.type === "agent:get_profile") {
        const profile = loadAgentProfile(event.payload.agentName);
        if (profile) {
          ws.send(JSON.stringify({ type: "agent:profile", payload: profile } satisfies ServerEvent));
        }
      }
    } catch {
      // ignore
    }
  });

  ws.on("close", () => subscribers.delete(ws));
});

onArenaStateChange((state) => {
  broadcast({ type: "arena:state", payload: state });
});

server.listen(PORT, () => {
  console.log(`Chess Arena running on http://localhost:${PORT}`);
  startArena((event) => broadcast(event)).catch((err) => {
    console.error("Arena error:", err);
  });
});
