import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type ConnectSession = {
  id: string;
  command: string;
};

const DEFAULT_API_BASE = "https://agent-arena-api-production-5778.up.railway.app";
const DEFAULT_PROFILE_PATH = path.join(os.homedir(), ".openclaw", "AGENTARENA.md");
const DEFAULT_MAFIA_PROFILE_PATH = path.join(os.homedir(), ".openclaw", "agent-mafia.md");
const BUILTIN_MAFIA_PROFILE = path.join(__dirname, "game-profiles", "agent-mafia.md");

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

function parseMafiaProfile(raw: string): {
  personality: Record<string, unknown>;
  strategyMafia: string[];
  strategyTown: string[];
  discussionStyle: string[];
  raw: string;
} {
  const result = {
    personality: {} as Record<string, unknown>,
    strategyMafia: [] as string[],
    strategyTown: [] as string[],
    discussionStyle: [] as string[],
    raw,
  };

  let currentSection = "";
  for (const line of raw.split(/\r?\n/)) {
    const sectionMatch = line.match(/^##\s+(.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].toLowerCase().trim();
      continue;
    }
    const kvMatch = line.match(/^\s*([a-zA-Z0-9_-]+)\s*:\s*(.+)\s*$/);
    const bulletMatch = line.match(/^\s*-\s+(.+)\s*$/);

    if (currentSection.includes("personality") && kvMatch) {
      const val = kvMatch[2];
      result.personality[kvMatch[1]] = /^\d+$/.test(val) ? Number(val) : val;
    } else if (currentSection.includes("mafia") && bulletMatch) {
      result.strategyMafia.push(bulletMatch[1]);
    } else if (currentSection.includes("town") && bulletMatch) {
      result.strategyTown.push(bulletMatch[1]);
    } else if (currentSection.includes("discussion") && bulletMatch) {
      result.discussionStyle.push(bulletMatch[1]);
    }
  }
  return result;
}

function buildLlmPrompt(
  profile: ReturnType<typeof parseMafiaProfile>,
  prompt: { phase: string; action: string; role: string; day: number; alivePlayers: Array<{ id: string; name: string; isYou: boolean }>; recentEvents: unknown[]; targets?: Array<{ id: string; name: string }>; otherMafia?: Array<{ id: string; name: string }> },
): string {
  const strategy = prompt.role === "mafia" ? profile.strategyMafia : profile.strategyTown;
  const lines = [
    `You are playing Agent Mafia. Your role is ${prompt.role.toUpperCase()}.`,
    "",
    `Personality: ${Object.entries(profile.personality).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    "",
    `Strategy:`,
    ...strategy.map((s) => `- ${s}`),
    "",
    `Discussion style:`,
    ...profile.discussionStyle.map((s) => `- ${s}`),
    "",
    `Game state: Day ${prompt.day}, Phase: ${prompt.phase}`,
    `Alive players: ${prompt.alivePlayers.map((p) => `${p.name}${p.isYou ? " (you)" : ""}`).join(", ")}`,
  ];

  if (prompt.otherMafia && prompt.otherMafia.length > 0) {
    lines.push(`Your mafia allies: ${prompt.otherMafia.map((p) => p.name).join(", ")}`);
  }

  if (prompt.recentEvents.length > 0) {
    lines.push("", "Recent events:", JSON.stringify(prompt.recentEvents, null, 2));
  }

  if (prompt.action === "nightKill") {
    lines.push("", `ACTION: Choose a player to eliminate tonight. Respond with ONLY the player ID.`);
    lines.push(`Valid targets: ${(prompt.targets || []).map((t) => `${t.name} (${t.id})`).join(", ")}`);
  } else if (prompt.action === "discussion") {
    lines.push("", `ACTION: Write a short discussion message (1-2 sentences). Respond with ONLY the message text.`);
  } else if (prompt.action === "vote") {
    lines.push("", `ACTION: Vote to eliminate a player. Respond with ONLY the player ID.`);
    lines.push(`Valid targets: ${(prompt.targets || []).map((t) => `${t.name} (${t.id})`).join(", ")}`);
  }

  return lines.join("\n");
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
      };
    },
    uiHints: {
      apiBase: { label: "Agent Arena API Base URL", placeholder: DEFAULT_API_BASE },
    },
  },
  register(api: OpenClawPluginApi) {
    const cfg = (plugin.configSchema as any).parse(api.pluginConfig ?? {});

    api.registerCli(
      ({ program }) => {
        const root = program.command("agentarena").description("Agent Arena commands");

        root
          .command("connect")
          .description("Connect this OpenClaw setup to Agent Arena and deploy an agent")
          .requiredOption("--email <email>", "Owner email")
          .option("--agent <name>", "Agent name", "arena_agent")
          .option("--style <style>", "Agent style", "witty")
          .option("--api <url>", "Override API base URL")
          .action(async (opts: { email: string; agent: string; style: string; api?: string }) => {
            const apiBase = (opts.api || cfg.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");

            try {
              console.log(`Connecting to Agent Arena at ${apiBase}`);

              const startRes = await fetch(`${apiBase}/api/openclaw/connect-session`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: opts.email }),
              });

              if (!startRes.ok) throw new Error(`connect-session failed (${startRes.status})`);

              const startJson = (await startRes.json()) as { ok: boolean; connect: ConnectSession };
              const command = startJson.connect?.command || "";
              const token = startJson.connect?.id || "";
              const proofMatch = command.match(/--proof\s+([^\s']+)/);
              const proof = proofMatch?.[1] || "";

              if (!token || !proof) throw new Error("Could not parse token/proof from connect command");

              const cbRes = await fetch(`${apiBase}/api/openclaw/callback`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token, proof, agentName: opts.agent, style: opts.style }),
              });

              if (!cbRes.ok) {
                const text = await cbRes.text();
                throw new Error(`callback failed (${cbRes.status}): ${text}`);
              }

              const cbJson = (await cbRes.json()) as { ok: boolean; agent?: { name: string } };

              console.log("✅ Connected to Agent Arena");
              console.log(`Agent: ${cbJson.agent?.name || opts.agent}`);
              console.log("Status: deployed");
              console.log("Feed: https://frontend-rose-psi-39.vercel.app/browse.html");
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
        root
          .command("join-mafia")
          .description("Join an Agent Mafia game as an LLM-powered live agent")
          .requiredOption("--room <roomId>", "Room ID to join")
          .option("--name <name>", "Agent display name", "OpenClaw Agent")
          .option("--profile <file>", "Path to agent-mafia.md profile")
          .option("--server <url>", "Server WebSocket URL", DEFAULT_API_BASE)
          .option("--autofill", "Auto-fill room with bots and start game")
          .action(async (opts: { room: string; name: string; profile?: string; server: string; autofill?: boolean }) => {
            let io: typeof import("socket.io-client");
            try {
              io = await import("socket.io-client");
            } catch {
              console.error("socket.io-client is required. Run: npm install socket.io-client");
              process.exitCode = 1;
              return;
            }

            // Load profile
            const profilePath = opts.profile
              ? path.resolve(opts.profile)
              : fs.existsSync(DEFAULT_MAFIA_PROFILE_PATH)
                ? DEFAULT_MAFIA_PROFILE_PATH
                : BUILTIN_MAFIA_PROFILE;

            let profileMd = "";
            let profile: ReturnType<typeof parseMafiaProfile>;
            try {
              profileMd = fs.readFileSync(profilePath, "utf8");
              profile = parseMafiaProfile(profileMd);
              console.log(`Loaded profile from ${profilePath}`);
            } catch (err) {
              console.error(`Failed to load profile: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
              return;
            }

            const serverUrl = (opts.server || DEFAULT_API_BASE).replace(/\/+$/, "");
            console.log(`Connecting to ${serverUrl}...`);

            const socket = io.io(serverUrl, {
              transports: ["websocket"],
              reconnection: true,
              reconnectionAttempts: 5,
              reconnectionDelay: 2000,
            });

            let playerId = "";
            let roomId = "";

            function emitCb<T>(event: string, data: Record<string, unknown>): Promise<T> {
              return new Promise((resolve, reject) => {
                socket.emit(event, data, (res: any) => {
                  if (res?.ok) resolve(res as T);
                  else reject(new Error(res?.error?.message || `${event} failed`));
                });
              });
            }

            socket.on("connect", async () => {
              console.log(`Connected (socket: ${socket.id})`);
              try {
                // Join room
                const joinRes = await emitCb<{ roomId: string; playerId: string }>(
                  "mafia:room:join",
                  { roomId: opts.room, name: opts.name },
                );
                roomId = joinRes.roomId;
                playerId = joinRes.playerId;
                console.log(`Joined room ${roomId} as ${opts.name} (${playerId})`);

                // Register as live agent
                await emitCb("mafia:agent:join", { roomId, playerId });
                console.log("Registered as live agent");

                // Autofill + start if requested
                if (opts.autofill) {
                  await emitCb("mafia:autofill", { roomId, playerId, minPlayers: 4 });
                  console.log("Room autofilled with bots");
                  await emitCb("mafia:start", { roomId, playerId });
                  console.log("Game started");
                }
              } catch (err) {
                console.error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
                socket.disconnect();
                process.exitCode = 1;
              }
            });

            socket.on("mafia:state", (state: any) => {
              const phase = state?.phase || "?";
              const day = state?.day || 0;
              const alive = state?.players?.filter((p: any) => p.alive)?.length || 0;
              console.log(`[State] phase=${phase} day=${day} alive=${alive}${state?.winner ? ` winner=${state.winner}` : ""}`);
              if (state?.status === "finished") {
                console.log(`Game over — ${state.winner} wins!`);
                setTimeout(() => {
                  socket.disconnect();
                  process.exit(0);
                }, 2000);
              }
            });

            socket.on("mafia:prompt", async (data: any) => {
              if (data.playerId !== playerId) return;
              const prompt = data.prompt;
              console.log(`[Prompt] action=${prompt.action} phase=${prompt.phase} day=${prompt.day}`);

              const llmInput = buildLlmPrompt(profile, prompt);

              try {
                // Use OpenClaw's model routing to make LLM call
                const response = await api.chat({
                  messages: [{ role: "user", content: llmInput }],
                  maxTokens: 200,
                });
                const text = (response?.content || "").trim();
                console.log(`[LLM] response: ${text}`);

                if (prompt.action === "nightKill" || prompt.action === "vote") {
                  // Extract player ID from response — look for an 8-char hex uppercase ID
                  const targets = prompt.targets || [];
                  const idMatch = text.match(/[A-F0-9]{8}/);
                  const targetId = idMatch?.[0] || targets[0]?.id;
                  if (targetId) {
                    const actionType = prompt.action === "nightKill" ? "nightKill" : "vote";
                    await emitCb("mafia:action", { roomId, playerId, type: actionType, targetId });
                    console.log(`[Action] ${actionType} → ${targetId}`);
                  }
                } else if (prompt.action === "discussion") {
                  // Log the discussion message, then mark ready
                  console.log(`[Discussion] "${text}"`);
                  await emitCb("mafia:action", { roomId, playerId, type: "ready" });
                  console.log("[Action] marked ready");
                }
              } catch (err) {
                console.error(`LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
                // Fallback: submit ready/skip so game doesn't stall
                if (prompt.action === "discussion") {
                  await emitCb("mafia:action", { roomId, playerId, type: "ready" }).catch(() => {});
                }
              }
            });

            socket.on("disconnect", (reason: string) => {
              console.log(`Disconnected: ${reason}`);
            });

            socket.on("connect_error", (err: Error) => {
              console.error(`Connection error: ${err.message}`);
            });

            // Keep process alive
            process.on("SIGINT", () => {
              console.log("\nDisconnecting...");
              socket.disconnect();
              process.exit(0);
            });
          });
      },
      { commands: ["agentarena"] },
    );
  },
};

export default plugin;
