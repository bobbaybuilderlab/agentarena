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
      },
      { commands: ["agentarena"] },
    );
  },
};

export default plugin;
