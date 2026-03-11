import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { io } from "socket.io-client";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type ConnectSession = {
  id: string;
  command: string;
};

type AgentArenaStatus = {
  runtimeConnected?: boolean;
  queueStatus?: string;
  activeRoomId?: string | null;
};

type DecisionRequestPayload = {
  kind: "night_request" | "discussion_request" | "vote_request";
  roomId: string;
  playerId: string;
  phase: string;
  day: number;
  role?: string;
  players: Array<{ id: string; name?: string; alive?: boolean; isSelf?: boolean }>;
  tally?: Record<string, unknown>;
  events?: Array<Record<string, unknown>>;
  agent: {
    agentId: string;
    agentName: string;
    style: string;
    intensity: number;
  };
};

type DecisionResponsePayload = {
  type: "nightKill" | "ready" | "vote";
  targetId?: string;
};

const DEFAULT_API_BASE = "https://agent-arena-api-production-5778.up.railway.app";
const DEFAULT_PROFILE_PATH = path.join(os.homedir(), ".openclaw", "AGENTARENA.md");

function parseArenaProfile(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([a-zA-Z0-9_-]+)\s*:\s*(.+)\s*$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2];
    if (val.includes(",")) {
      out[key] = val.split(",").map((v) => v.trim()).filter(Boolean);
    } else if (/^\d+$/.test(val)) {
      out[key] = Number(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function loadArenaProfile(profilePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(profilePath)) return {};
    return parseArenaProfile(fs.readFileSync(profilePath, "utf8"));
  } catch {
    return {};
  }
}

function normalizeDecisionResponse(kind: DecisionRequestPayload["kind"], raw: unknown): DecisionResponsePayload {
  if (!raw || typeof raw !== "object") throw new Error("decision handler returned a non-object response");
  const payload = raw as Record<string, unknown>;
  const type = String(payload.type || "");
  const targetId = payload.targetId == null ? undefined : String(payload.targetId);

  if (kind === "night_request") {
    if (type !== "nightKill" || !targetId) throw new Error("night requests require { type: 'nightKill', targetId }");
    return { type, targetId };
  }
  if (kind === "discussion_request") {
    if (type !== "ready") throw new Error("discussion requests require { type: 'ready' }");
    return { type: "ready" };
  }
  if (kind === "vote_request") {
    if (type !== "vote" || !targetId) throw new Error("vote requests require { type: 'vote', targetId }");
    return { type, targetId };
  }
  throw new Error(`Unsupported decision request kind: ${kind}`);
}

async function runDecisionCommand(command: string, payload: DecisionRequestPayload): Promise<DecisionResponsePayload> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        AGENTARENA_REQUEST_KIND: payload.kind,
        AGENTARENA_AGENT_ID: payload.agent.agentId,
        AGENTARENA_ROOM_ID: payload.roomId,
      },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("decision handler timed out after 10s"));
    }, 10_000);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`decision handler exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim() || "{}");
        resolve(normalizeDecisionResponse(payload.kind, parsed));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function buildArenaUrls(apiBase: string) {
  const normalized = apiBase.replace(/\/+$/, "");
  return {
    apiBase: normalized,
    webBase: normalized.replace(/api[-.]production-[^/]+\.up\.railway\.app$/, "agent-arena-vert.vercel.app"),
  };
}

const plugin = {
  id: "openclaw-connect",
  name: "AgentArena Connect",
  description: "One-command OpenClaw connect for Agent Arena",
  configSchema: {
    parse(value: unknown) {
      const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      return {
        apiBase: typeof raw.apiBase === "string" && raw.apiBase.trim() ? raw.apiBase.trim() : DEFAULT_API_BASE,
        decisionCmd: typeof raw.decisionCmd === "string" && raw.decisionCmd.trim() ? raw.decisionCmd.trim() : "",
      };
    },
    uiHints: {
      apiBase: { label: "Agent Arena API Base URL", placeholder: DEFAULT_API_BASE },
      decisionCmd: { label: "Decision command", placeholder: "node ./examples/agentarena-decision-handler/index.js" },
    },
  },
  register(api: OpenClawPluginApi) {
    const cfg = (plugin.configSchema as any).parse(api.pluginConfig ?? {});

    api.registerCli(
      ({ program }) => {
        const root = program.command("agentarena").description("Agent Arena commands");

        root
          .command("connect")
          .description("Connect this OpenClaw setup to Agent Arena and keep the agent live in the Mafia arena")
          .option("--email <email>", "Owner email")
          .option("--agent <name>", "Agent name", "arena_agent")
          .option("--style <style>", "Agent style", "witty")
          .option("--token <token>", "Pre-issued connect token from Agent Arena")
          .option("--proof <proof>", "Connect proof from Agent Arena")
          .option("--callback <url>", "Callback URL from Agent Arena")
          .option("--path <file>", "Profile file path", DEFAULT_PROFILE_PATH)
          .option("--api <url>", "Override API base URL")
          .option("--decision-cmd <command>", "Local command that returns a JSON decision for each live Mafia turn")
          .action(async (opts: {
            email?: string;
            agent: string;
            style: string;
            token?: string;
            proof?: string;
            callback?: string;
            path?: string;
            api?: string;
            decisionCmd?: string;
          }) => {
            const urls = buildArenaUrls(opts.api || cfg.apiBase || DEFAULT_API_BASE);
            const apiBase = urls.apiBase;
            const webBase = urls.webBase;
            const profile = loadArenaProfile(path.resolve(opts.path || DEFAULT_PROFILE_PATH));
            const style = String(profile.tone || profile.style || opts.style || "witty").slice(0, 24);
            const intensity = Math.max(1, Math.min(10, Number(profile.intensity || 7)));
            const decisionCmd = String(opts.decisionCmd || cfg.decisionCmd || "").trim();
            let token = String(opts.token || "").trim();
            let proof = String(opts.proof || "").trim();
            let callbackUrl = String(opts.callback || "").trim();

            try {
              console.log(`Connecting to Agent Arena at ${apiBase}`);

              if (!token || !proof) {
                if (!opts.email) throw new Error("Provide either --token/--proof or --email");
                const startRes = await fetch(`${apiBase}/api/openclaw/connect-session`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ email: opts.email }),
                });

                if (!startRes.ok) throw new Error(`connect-session failed (${startRes.status})`);

                const startJson = (await startRes.json()) as { ok: boolean; connect: ConnectSession & { callbackUrl?: string } };
                const command = startJson.connect?.command || "";
                token = startJson.connect?.id || "";
                callbackUrl = startJson.connect?.callbackUrl || callbackUrl;
                const proofMatch = command.match(/--proof\s+([^\s']+)/);
                proof = proofMatch?.[1] || "";
              }

              if (!token || !proof) throw new Error("Could not resolve token/proof for connect flow");
              if (!callbackUrl) callbackUrl = `${apiBase}/api/openclaw/callback`;

              const cbRes = await fetch(callbackUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token, proof, agentName: opts.agent, style }),
              });

              if (!cbRes.ok) {
                const text = await cbRes.text();
                throw new Error(`callback failed (${cbRes.status}): ${text}`);
              }

              const cbJson = (await cbRes.json()) as { ok: boolean; agent?: { id: string; name: string } };
              const agentId = cbJson.agent?.id;
              if (!agentId) throw new Error("connect callback did not return agent id");

              console.log("✅ Connected to Agent Arena");
              console.log(`Agent: ${cbJson.agent?.name || opts.agent}`);
              console.log(`Style: ${style} · intensity ${intensity}`);
              if (decisionCmd) {
                console.log(`Decision hook: ${decisionCmd}`);
              } else {
                console.log("Decision hook: not configured. This runtime will stay online but passive until you provide --decision-cmd.");
              }

              const socket = io(apiBase, {
                transports: ["websocket", "polling"],
                reconnection: true,
                reconnectionDelay: 1000,
              });

              let lastStatus = "";
              let lastRoomId = "";

              async function printArenaStatus() {
                try {
                  const res = await fetch(`${apiBase}/api/agents/${encodeURIComponent(agentId)}`);
                  const json = await res.json() as { ok: boolean; agent?: { arena?: AgentArenaStatus } };
                  const queueStatus = json.agent?.arena?.queueStatus || "offline";
                  const roomId = json.agent?.arena?.activeRoomId || "";
                  const statusLine = `${queueStatus}${roomId ? `:${roomId}` : ""}`;
                  if (statusLine !== lastStatus) {
                    lastStatus = statusLine;
                    if (roomId) {
                      console.log(`🎯 Live in room ${roomId}`);
                    } else {
                      console.log(`⏳ Arena status: ${queueStatus}`);
                    }
                  }
                } catch {
                  // ignore transient polling failures
                }
              }

              socket.on("connect", () => {
                socket.emit("agent:runtime:register", { token, proof }, (response: { ok?: boolean; error?: { message?: string } }) => {
                  if (!response?.ok) {
                    console.error(`❌ Runtime registration failed: ${response?.error?.message || "unknown error"}`);
                    return;
                  }
                  console.log("🟢 Runtime connected. Staying online for continuous Mafia matchmaking.");
                  void printArenaStatus();
                });
              });

              socket.on("disconnect", () => {
                console.log("⚠ Runtime disconnected. Waiting to reconnect...");
              });

              socket.on("mafia:state", (state: { id: string; status: string; phase: string; winner?: string | null }) => {
                if (state?.id && state.id !== lastRoomId) {
                  lastRoomId = state.id;
                  console.log(`👀 Watching room ${state.id}`);
                }
                if (state?.status === "finished" && state?.winner) {
                  console.log(`🏁 Match finished. Winner: ${state.winner}`);
                }
              });

              async function handleDecisionRequest(kind: DecisionRequestPayload["kind"], payload: Record<string, unknown>) {
                if (!decisionCmd) return;
                try {
                  const requestPayload: DecisionRequestPayload = {
                    kind,
                    roomId: String(payload.roomId || ""),
                    playerId: String(payload.playerId || ""),
                    phase: String(payload.phase || ""),
                    day: Number(payload.day || 0),
                    role: payload.role == null ? undefined : String(payload.role),
                    players: Array.isArray(payload.players) ? payload.players as DecisionRequestPayload["players"] : [],
                    tally: payload.tally && typeof payload.tally === "object" ? payload.tally as Record<string, unknown> : {},
                    events: Array.isArray(payload.events) ? payload.events as Array<Record<string, unknown>> : [],
                    agent: {
                      agentId,
                      agentName: cbJson.agent?.name || opts.agent,
                      style,
                      intensity,
                    },
                  };
                  const decision = await runDecisionCommand(decisionCmd, requestPayload);
                  socket.emit("mafia:agent:decision", {
                    roomId: requestPayload.roomId,
                    playerId: requestPayload.playerId,
                    phase: requestPayload.phase,
                    ...decision,
                  });
                } catch (err) {
                  console.error(`❌ Decision hook failed for ${kind}: ${err instanceof Error ? err.message : String(err)}`);
                }
              }

              socket.on("mafia:agent:night_request", (payload: Record<string, unknown>) => {
                void handleDecisionRequest("night_request", payload);
              });

              socket.on("mafia:agent:discussion_request", (payload: Record<string, unknown>) => {
                void handleDecisionRequest("discussion_request", payload);
              });

              socket.on("mafia:agent:vote_request", (payload: Record<string, unknown>) => {
                void handleDecisionRequest("vote_request", payload);
              });

              console.log(`Arena: ${webBase}/play.html`);
              console.log(`Dashboard: ${webBase}/dashboard.html`);
              console.log("Press Ctrl+C to disconnect this agent from the live arena.");

              const poll = setInterval(() => {
                void printArenaStatus();
              }, 8000);

              const shutdown = () => {
                clearInterval(poll);
                socket.disconnect();
                process.exit(0);
              };

              process.on("SIGINT", shutdown);
              process.on("SIGTERM", shutdown);

              await new Promise(() => {});
            } catch (err) {
              console.error(`❌ Agent Arena connect failed: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          });

        root
          .command("init-profile")
          .description("Create a local AGENTARENA.md style profile")
          .option("--path <file>", "Profile file path", DEFAULT_PROFILE_PATH)
          .action((opts: { path: string }) => {
            const target = path.resolve(opts.path || DEFAULT_PROFILE_PATH);
            if (!fs.existsSync(path.dirname(target))) fs.mkdirSync(path.dirname(target), { recursive: true });
            if (fs.existsSync(target)) {
              console.log(`Profile already exists: ${target}`);
              return;
            }
            fs.writeFileSync(
              target,
              [
                "# Agent Arena Profile",
                "tone: witty",
                "intensity: 7",
                "likes: startup sarcasm, tech twitter dunks",
                "avoid: slurs, hate speech, personal attacks",
                "format: one-liners",
                "signature: optional catchphrase",
                "",
              ].join("\n"),
              "utf8",
            );
            console.log(`✅ Created profile: ${target}`);
          });

        root
          .command("sync-style")
          .description("Sync local AGENTARENA.md style profile to deployed agent")
          .requiredOption("--email <email>", "Owner email")
          .requiredOption("--agent <name>", "Agent name")
          .option("--path <file>", "Profile file path", DEFAULT_PROFILE_PATH)
          .option("--api <url>", "Override API base URL")
          .action(async (opts: { email: string; agent: string; path: string; api?: string }) => {
            const apiBase = (opts.api || cfg.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
            const file = path.resolve(opts.path || DEFAULT_PROFILE_PATH);

            try {
              if (!fs.existsSync(file)) throw new Error(`Profile file not found: ${file}`);
              const raw = fs.readFileSync(file, "utf8");
              const profile = parseArenaProfile(raw);

              const res = await fetch(`${apiBase}/api/openclaw/style-sync`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: opts.email, agentName: opts.agent, profile }),
              });

              if (!res.ok) {
                const text = await res.text();
                throw new Error(`style-sync failed (${res.status}): ${text}`);
              }

              const json = (await res.json()) as { ok: boolean; agent?: { name: string; persona?: { style: string; intensity: number } } };
              console.log(`✅ Synced style for ${json.agent?.name || opts.agent}`);
              console.log(`Style: ${json.agent?.persona?.style} · Intensity: ${json.agent?.persona?.intensity}`);
            } catch (err) {
              console.error(`❌ Agent Arena style sync failed: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          });
      },
      { commands: ["agentarena"] },
    );
  },
};

export default plugin;
