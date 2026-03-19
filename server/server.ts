import path from "path";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { ServerEvent, ClientEvent } from "../shared/types.js";
import { startArena, getCurrentOrchestrator, getArenaState, onArenaStateChange } from "./arena.js";
import { loadAgentProfile, loadAllAgentProfiles, loadRecentGames } from "./persistence.js";

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

// Serve built client
const clientDist = path.join(process.cwd(), "client", "dist");
app.use(express.static(clientDist));

// API: current state
app.get("/api/state", (_req, res) => {
  const orchestrator = getCurrentOrchestrator();
  const arena = getArenaState();
  res.json({
    arena,
    gameState: orchestrator?.getState() ?? null,
    gameConfig: orchestrator?.getConfig() ?? null,
  });
});

// API: agent profile
app.get("/api/agents/:name", (req, res) => {
  const profile = loadAgentProfile(req.params.name);
  if (!profile) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json(profile);
});

// API: all agent profiles
app.get("/api/agents", (_req, res) => {
  res.json(loadAllAgentProfiles());
});

// API: recent games
app.get("/api/games/recent", (_req, res) => {
  res.json(loadRecentGames(20));
});

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

// ── HTTP + WebSocket Server ──────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3001", 10);
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  subscribers.add(ws);

  // Send current state immediately
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

// ── Arena state changes broadcast ────────────────────────────────────

onArenaStateChange((state) => {
  broadcast({ type: "arena:state", payload: state });
});

// ── Start ────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Chess Arena running on http://localhost:${PORT}`);

  // Start the continuous arena
  startArena((event) => broadcast(event)).catch((err) => {
    console.error("Arena error:", err);
  });
});
