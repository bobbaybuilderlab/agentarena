import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const require = createRequire(import.meta.url);
const {
  DEFAULT_PRESET_ID,
  buildResolvedPersona,
} = require("./style-presets.cjs") as {
  DEFAULT_PRESET_ID: string;
  buildResolvedPersona: (args?: { presetId?: unknown; style?: unknown; fallbackPresetId?: string }) => {
    presetId: string;
    style: string;
    preset: { id: string; label: string; starterPrompt: string };
  };
};

type ConnectSession = {
  id: string;
  command: string;
  callbackUrl?: string;
  callbackProof?: string;
  onboarding?: {
    connectCommand?: string;
  };
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
    presetId: string;
    style: string;
    intensity: number;
  };
};

type DecisionResponsePayload = {
  type: "nightKill" | "ready" | "vote";
  targetId?: string;
  message?: string;
};

const DEFAULT_API_BASE = process.env.CLAWOFDECEIT_API_BASE?.trim()
  || process.env.AGENTARENA_API_BASE?.trim()
  || "http://127.0.0.1:3000";
const DEFAULT_PROFILE_PATH = path.join(os.homedir(), ".openclaw", "CLAWOFDECEIT.md");
const LEGACY_PROFILE_PATH = path.join(os.homedir(), ".openclaw", "AGENTARENA.md");
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const STARTER_STRATEGY_CMD = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(MODULE_DIR, "starter-strategy.js"))}`;
const FALLBACK_DISCUSSION_MESSAGE = "I'm locking a public read before the vote.";

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
    const resolvedPath = fs.existsSync(profilePath)
      ? profilePath
      : profilePath === DEFAULT_PROFILE_PATH && fs.existsSync(LEGACY_PROFILE_PATH)
        ? LEGACY_PROFILE_PATH
        : profilePath;
    if (!fs.existsSync(resolvedPath)) return {};
    return parseArenaProfile(fs.readFileSync(resolvedPath, "utf8"));
  } catch {
    return {};
  }
}

function resolveArenaPersona(args: {
  profile?: Record<string, unknown>;
  presetId?: string;
  style?: string;
}) {
  const profile = args.profile ?? {};
  const profileStyle = typeof profile.tone === "string" && profile.tone.trim()
    ? profile.tone
    : typeof profile.style === "string" && profile.style.trim()
      ? profile.style
      : "";
  const profilePresetId = typeof profile.preset === "string" && profile.preset.trim()
    ? profile.preset
    : "";
  const resolved = buildResolvedPersona({
    presetId: profilePresetId || args.presetId,
    style: profileStyle || args.style,
    fallbackPresetId: DEFAULT_PRESET_ID,
  });
  const intensitySource = typeof profile.intensity === "number" || typeof profile.intensity === "string"
    ? Number(profile.intensity)
    : 7;

  return {
    ...resolved,
    intensity: Math.max(1, Math.min(10, Number.isFinite(intensitySource) ? intensitySource : 7)),
  };
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
    const message = String(payload.message || "").trim().replace(/\s+/g, " ").slice(0, 280);
    if (!message) {
      console.warn("[clawofdeceit] discussion handler returned no public message; using fallback copy.");
      return { type: "ready", message: FALLBACK_DISCUSSION_MESSAGE };
    }
    return { type: "ready", message };
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
        CLAWOFDECEIT_REQUEST_KIND: payload.kind,
        CLAWOFDECEIT_AGENT_ID: payload.agent.agentId,
        CLAWOFDECEIT_ROOM_ID: payload.roomId,
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
    webBase: normalized,
  };
}

type RuntimeCredential = {
  agentId: string;
  runtimeSecret: string;
};

type ConnectCallbackResponse = {
  ok: boolean;
  connect?: {
    connectedAt?: string | number | null;
  };
  agent?: {
    id: string;
    name: string;
    persona?: {
      style?: string;
      presetId?: string;
      intensity?: number;
    };
  };
  runtimeCredential?: RuntimeCredential | null;
};

type ManagedAgentResponse = {
  ok: boolean;
  error?: string;
  code?: string;
  agent?: {
    id: string;
    name: string;
    lifecycleState?: string;
    archivedAt?: string | null;
    lastConnectedAt?: string | null;
    arena?: AgentArenaStatus;
    persona?: {
      style?: string;
      presetId?: string;
      intensity?: number;
    };
  };
};

type SavedAgentBinding = {
  agentId: string;
  agentToken: string;
  serverName: string;
  presetId: string;
  style: string;
  decisionCmd: string;
  autoStart: boolean;
  status: string;
  createdAt: string;
  lastConnectedAt: string | null;
};

type BindingRegistry = {
  version: number;
  apiBase: string;
  defaultAgent: string | null;
  autoBoot: boolean;
  agents: Record<string, SavedAgentBinding>;
};

type AutoBootSyncResult = {
  supported: boolean;
  enabled: boolean;
  configured: boolean;
  activatedNow: boolean;
  path: string | null;
  label: string | null;
  note: string;
};

function normalizeLookupKey(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function sanitizeBindingName(value: unknown) {
  return String(value || "").trim().slice(0, 64);
}

function resolveCurrentProfileName() {
  const envProfile = String(process.env.OPENCLAW_PROFILE || "").trim();
  if (envProfile) return envProfile;
  const args = process.argv || [];
  const idx = args.lastIndexOf("--profile");
  if (idx >= 0) {
    const candidate = String(args[idx + 1] || "").trim();
    if (candidate) return candidate;
  }
  return "main";
}

function getRegistryDir(profileName: string) {
  return path.join(os.homedir(), ".openclaw", "clawofdeceit", "profiles", sanitizeBindingName(profileName) || "main");
}

function getRegistryPath(profileName: string) {
  return path.join(getRegistryDir(profileName), "agents.json");
}

function getHostLockPath(profileName: string) {
  return path.join(getRegistryDir(profileName), "host.lock");
}

function getLaunchAgentsDir() {
  return String(process.env.CLAWOFDECEIT_LAUNCH_AGENTS_DIR || "").trim()
    || path.join(os.homedir(), "Library", "LaunchAgents");
}

function sanitizeLaunchLabelComponent(value: unknown) {
  const normalized = String(value || "").trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "main";
}

function getLaunchAgentLabel(profileName: string) {
  return `com.clawofdeceit.openclaw.${sanitizeLaunchLabelComponent(profileName)}`;
}

function getLaunchAgentPath(profileName: string) {
  return path.join(getLaunchAgentsDir(), `${getLaunchAgentLabel(profileName)}.plist`);
}

function getLaunchAgentLogPath(profileName: string, kind: "out" | "err") {
  return path.join(getRegistryDir(profileName), `autostart.${kind}.log`);
}

function ensureDirectory(target: string) {
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
}

function writeTextFileAtomic(target: string, content: string, mode = 0o600) {
  ensureDirectory(path.dirname(target));
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: "utf8", mode });
  fs.renameSync(tmp, target);
}

function defaultRegistry(apiBase = ""): BindingRegistry {
  return {
    version: 2,
    apiBase: apiBase.replace(/\/+$/, ""),
    defaultAgent: null,
    autoBoot: true,
    agents: {},
  };
}

function normalizeSavedAgentBinding(raw: unknown): SavedAgentBinding | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const agentId = String(input.agentId || "").trim();
  const agentToken = String(input.agentToken || input.runtimeSecret || "").trim();
  const serverName = sanitizeBindingName(input.serverName || input.agentName || input.name || agentId);
  if (!agentId || !agentToken || !serverName) return null;
  return {
    agentId,
    agentToken,
    serverName,
    presetId: String(input.presetId || DEFAULT_PRESET_ID).trim() || DEFAULT_PRESET_ID,
    style: String(input.style || "").trim() || serverName,
    decisionCmd: String(input.decisionCmd || "").trim(),
    autoStart: input.autoStart !== false,
    status: String(input.status || "offline").trim() || "offline",
    createdAt: String(input.createdAt || new Date().toISOString()),
    lastConnectedAt: input.lastConnectedAt == null ? null : String(input.lastConnectedAt),
  };
}

function normalizeRegistry(raw: unknown, apiBase = ""): BindingRegistry {
  const base = defaultRegistry(apiBase);
  if (!raw || typeof raw !== "object") return base;
  const input = raw as Record<string, unknown>;
  const agents: Record<string, SavedAgentBinding> = {};
  const rawAgents = input.agents && typeof input.agents === "object" ? input.agents as Record<string, unknown> : {};
  for (const [localName, rawBinding] of Object.entries(rawAgents)) {
    const binding = normalizeSavedAgentBinding(rawBinding);
    const key = sanitizeBindingName(localName);
    if (!binding || !key) continue;
    agents[key] = binding;
  }
  return {
    version: Number(input.version || 2) || 2,
    apiBase: String(input.apiBase || apiBase || "").trim().replace(/\/+$/, ""),
    defaultAgent: sanitizeBindingName(input.defaultAgent || "") || null,
    autoBoot: input.autoBoot !== false,
    agents,
  };
}

function readBindingRegistry(profileName: string, apiBase = "") {
  const file = getRegistryPath(profileName);
  try {
    if (!fs.existsSync(file)) return defaultRegistry(apiBase);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return normalizeRegistry(parsed, apiBase);
  } catch {
    return defaultRegistry(apiBase);
  }
}

function writeBindingRegistry(profileName: string, registry: BindingRegistry) {
  const target = getRegistryPath(profileName);
  const payload = JSON.stringify(normalizeRegistry(registry, registry.apiBase), null, 2);
  writeTextFileAtomic(target, payload, 0o600);
}

function findBindingEntry(registry: BindingRegistry, name: string) {
  const lookup = normalizeLookupKey(name || registry.defaultAgent || "");
  if (!lookup) return null;
  for (const [localName, binding] of Object.entries(registry.agents)) {
    if (normalizeLookupKey(localName) === lookup) return { localName, binding };
    if (normalizeLookupKey(binding.serverName) === lookup) return { localName, binding };
  }
  return null;
}

function listBindingEntries(registry: BindingRegistry) {
  return Object.entries(registry.agents).sort(([a], [b]) => a.localeCompare(b));
}

function hasSavedAutoStartAgents(registry: BindingRegistry) {
  return listBindingEntries(registry).some(([, binding]) => binding.autoStart !== false);
}

function saveBinding(profileName: string, apiBase: string, localName: string, binding: SavedAgentBinding) {
  const registry = readBindingRegistry(profileName, apiBase);
  const key = sanitizeBindingName(localName || binding.serverName);
  if (!key) throw new Error("Missing local agent name for saved binding");
  registry.apiBase = apiBase.replace(/\/+$/, "");
  for (const [existingName, existingBinding] of Object.entries(registry.agents)) {
    if (existingName !== key && existingBinding.agentId === binding.agentId) {
      delete registry.agents[existingName];
    }
  }
  registry.agents[key] = binding;
  registry.defaultAgent = key;
  writeBindingRegistry(profileName, registry);
  return registry;
}

function updateSavedBinding(profileName: string, localName: string, patch: Partial<SavedAgentBinding>) {
  const registry = readBindingRegistry(profileName);
  const entry = findBindingEntry(registry, localName);
  if (!entry) return registry;
  registry.agents[entry.localName] = {
    ...entry.binding,
    ...patch,
  };
  writeBindingRegistry(profileName, registry);
  return registry;
}

function removeSavedBinding(profileName: string, localName: string) {
  const registry = readBindingRegistry(profileName);
  const entry = findBindingEntry(registry, localName);
  if (!entry) return registry;
  delete registry.agents[entry.localName];
  if (registry.defaultAgent === entry.localName) {
    registry.defaultAgent = Object.keys(registry.agents)[0] || null;
  }
  writeBindingRegistry(profileName, registry);
  return registry;
}

function setRegistryAutoBoot(profileName: string, enabled: boolean, apiBase = "") {
  const registry = readBindingRegistry(profileName, apiBase);
  if (apiBase) registry.apiBase = apiBase.replace(/\/+$/, "");
  registry.autoBoot = enabled;
  writeBindingRegistry(profileName, registry);
  return registry;
}

function isProcessAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readActiveHostLock(profileName: string) {
  const lockPath = getHostLockPath(profileName);
  if (!fs.existsSync(lockPath)) return null;
  try {
    const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
    if (isProcessAlive(pid)) return pid;
  } catch {
    // fall through and clean stale lock
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // ignore stale-lock cleanup errors
  }
  return null;
}

function isAutoBootSupported() {
  return process.platform === "darwin";
}

function getLaunchCtlDomain() {
  const uid = typeof process.getuid === "function"
    ? process.getuid()
    : os.userInfo().uid;
  return `gui/${uid}`;
}

function runLaunchCtl(args: string[]) {
  if (String(process.env.CLAWOFDECEIT_SKIP_LAUNCHCTL || "").trim() === "1") {
    return {
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    };
  }
  return spawnSync("launchctl", args, {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function xmlEscape(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function resolveOpenClawBinary() {
  const envBinary = String(process.env.OPENCLAW_BIN || "").trim();
  if (envBinary) return envBinary;

  try {
    const probe = spawnSync("which", ["openclaw"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (probe.status === 0) {
      const found = String(probe.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (found) return found;
    }
  } catch {
    // fall through to the generic binary name
  }

  return "openclaw";
}

function renderAutoBootLaunchAgent(args: {
  profileName: string;
  apiBase: string;
}) {
  const programArguments = [
    resolveOpenClawBinary(),
    "--profile",
    args.profileName,
    "clawofdeceit",
    "agents",
    "start",
    "--all",
    "--allow-existing-host",
  ];
  if (args.apiBase) {
    programArguments.push("--api", args.apiBase);
  }
  const renderStringList = (values: string[]) => values.map((value) => `      <string>${xmlEscape(value)}</string>`).join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${xmlEscape(getLaunchAgentLabel(args.profileName))}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    renderStringList(programArguments),
    `  </array>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xmlEscape(os.homedir())}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>PATH</key>`,
    `    <string>${xmlEscape(String(process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"))}</string>`,
    `  </dict>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xmlEscape(getLaunchAgentLogPath(args.profileName, "out"))}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xmlEscape(getLaunchAgentLogPath(args.profileName, "err"))}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

function formatLaunchCtlFailure(args: string[], result: { status: number | null; stdout?: string; stderr?: string; error?: unknown }) {
  const detail = String(result.stderr || result.stdout || (result.error instanceof Error ? result.error.message : result.error || "")).trim();
  return `launchctl ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`;
}

function syncAutoBoot(profileName: string, apiBase = "", options?: {
  activateNow?: boolean;
  unloadNow?: boolean;
}): AutoBootSyncResult {
  const registry = readBindingRegistry(profileName, apiBase);
  const enabled = registry.autoBoot !== false;
  const configured = enabled && hasSavedAutoStartAgents(registry);
  const supported = isAutoBootSupported();
  const label = supported ? getLaunchAgentLabel(profileName) : null;
  const launchAgentPath = supported ? getLaunchAgentPath(profileName) : null;

  if (!supported) {
    return {
      supported,
      enabled,
      configured,
      activatedNow: false,
      path: null,
      label: null,
      note: enabled
        ? "Automatic startup is not available on this OS in the public connector build. Saved agents still keep the same identity; use `openclaw clawofdeceit agents start --all` after a restart."
        : "Automatic startup is disabled for this OpenClaw profile.",
    };
  }

  const activePid = readActiveHostLock(profileName);
  const domain = getLaunchCtlDomain();

  if (!configured) {
    if (launchAgentPath && fs.existsSync(launchAgentPath)) {
      if (!activePid && options?.unloadNow !== false) {
        const bootoutArgs = ["bootout", domain, launchAgentPath];
        const result = runLaunchCtl(bootoutArgs);
        if (result.status !== 0) {
          // ignore stale or already-unloaded jobs
        }
      }
      try {
        fs.unlinkSync(launchAgentPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      }
    }

    return {
      supported,
      enabled,
      configured,
      activatedNow: false,
      path: launchAgentPath,
      label,
      note: enabled
        ? "Automatic startup is enabled, but there are no saved auto-start agents for this profile yet."
        : activePid
          ? "Automatic startup was removed for future logins and reboots. The current host keeps running until you stop it."
          : "Automatic startup is disabled for this OpenClaw profile.",
    };
  }

  const normalizedApiBase = (registry.apiBase || apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  writeTextFileAtomic(launchAgentPath as string, renderAutoBootLaunchAgent({
    profileName,
    apiBase: normalizedApiBase,
  }), 0o644);

  if (!activePid && options?.activateNow) {
    const bootoutArgs = ["bootout", domain, launchAgentPath as string];
    runLaunchCtl(bootoutArgs);
    const bootstrapArgs = ["bootstrap", domain, launchAgentPath as string];
    const bootstrap = runLaunchCtl(bootstrapArgs);
    if (bootstrap.status !== 0) {
      throw new Error(formatLaunchCtlFailure(bootstrapArgs, bootstrap));
    }
    return {
      supported,
      enabled,
      configured,
      activatedNow: true,
      path: launchAgentPath,
      label,
      note: "Automatic startup is enabled for this OpenClaw profile and will revive saved agents on future login or reboot.",
    };
  }

  return {
    supported,
    enabled,
    configured,
    activatedNow: false,
    path: launchAgentPath,
    label,
    note: activePid
      ? "Automatic startup was updated for future logins and reboots. The current host was left running."
      : "Automatic startup is set for future logins and reboots for this OpenClaw profile.",
  };
}

function readAutoBootStatus(profileName: string, apiBase = "") {
  const registry = readBindingRegistry(profileName, apiBase);
  const enabled = registry.autoBoot !== false;
  const autoStartCount = listBindingEntries(registry).filter(([, binding]) => binding.autoStart !== false).length;
  const supported = isAutoBootSupported();
  const launchAgentPath = supported ? getLaunchAgentPath(profileName) : null;
  const configured = Boolean(launchAgentPath && fs.existsSync(launchAgentPath));
  const activePid = readActiveHostLock(profileName);

  let note = "";
  if (!enabled) {
    note = "Automatic startup is disabled for this OpenClaw profile.";
  } else if (!supported) {
    note = "Automatic startup is not available on this OS in the public connector build. Saved agents still reconnect with the same identity when you run `openclaw clawofdeceit agents start --all`.";
  } else if (!autoStartCount) {
    note = "Automatic startup is enabled, but there are no saved auto-start agents for this profile yet.";
  } else if (configured) {
    note = activePid
      ? "Automatic startup is configured, and a shared host is already running for this profile."
      : "Automatic startup is configured for future login and reboot.";
  } else {
    note = "Automatic startup is enabled, but the startup file has not been installed yet.";
  }

  return {
    profileName,
    enabled,
    supported,
    autoStartCount,
    path: launchAgentPath,
    configured,
    activePid,
    note,
  };
}

function acquireHostLock(profileName: string) {
  const activePid = readActiveHostLock(profileName);
  if (activePid) {
    throw new Error(`Claw of Deceit host already running for profile ${profileName} (pid ${activePid})`);
  }
  const lockPath = getHostLockPath(profileName);
  ensureDirectory(path.dirname(lockPath));
  fs.writeFileSync(lockPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return () => {
    try {
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch {
      // ignore lock cleanup failures on shutdown
    }
  };
}

function buildAgentAuthHeaders(binding: SavedAgentBinding) {
  return {
    Authorization: `Bearer ${binding.agentToken}`,
    "X-OpenClaw-Agent-Id": binding.agentId,
  };
}

async function fetchManagedAgent(apiBase: string, binding: SavedAgentBinding) {
  const res = await fetch(`${apiBase}/api/openclaw/agents/${encodeURIComponent(binding.agentId)}`, {
    headers: buildAgentAuthHeaders(binding),
  });
  const json = await res.json() as ManagedAgentResponse;
  if (!res.ok || !json?.ok) {
    const message = json?.error || `managed agent status failed (${res.status})`;
    throw new Error(message);
  }
  return json;
}

async function archiveManagedAgent(apiBase: string, binding: SavedAgentBinding) {
  const res = await fetch(`${apiBase}/api/openclaw/agents/${encodeURIComponent(binding.agentId)}/archive`, {
    method: "POST",
    headers: buildAgentAuthHeaders(binding),
  });
  const json = await res.json() as { ok: boolean; error?: string };
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error || `archive failed (${res.status})`);
  }
}

function formatRemoteStatus(agent?: ManagedAgentResponse["agent"]) {
  const lifecycle = String(agent?.lifecycleState || "active").trim().toLowerCase();
  if (lifecycle === "archived") return "archived";
  const roomId = String(agent?.arena?.activeRoomId || "").trim();
  if (roomId) return `live:${roomId}`;
  return String(agent?.arena?.queueStatus || "offline").trim() || "offline";
}

async function printSavedAgentsList(profileName: string, apiBase: string) {
  const registry = readBindingRegistry(profileName, apiBase);
  const entries = listBindingEntries(registry);
  if (!entries.length) {
    console.log(`No saved Claw of Deceit agents for profile ${profileName}.`);
    return;
  }

  for (const [localName, binding] of entries) {
    let status = binding.status || "offline";
    try {
      const managed = await fetchManagedAgent(apiBase, binding);
      status = formatRemoteStatus(managed.agent);
      updateSavedBinding(profileName, localName, {
        status,
        lastConnectedAt: managed.agent?.lastConnectedAt || binding.lastConnectedAt || null,
      });
    } catch {
      // keep last known local status
    }
    console.log(`- ${localName} (${binding.serverName}, ${binding.presetId}) ${status} · ${binding.autoStart !== false ? "auto-start" : "manual-start"}`);
  }
}

function describeDecisionMode(decisionCmd: string) {
  if (decisionCmd === STARTER_STRATEGY_CMD) {
    return "starter Mafia strategy";
  }
  return decisionCmd ? `decision hook ${decisionCmd}` : "no decision command";
}

async function createSavedBinding(args: {
  apiBase: string;
  callbackUrl: string;
  token: string;
  proof: string;
  agentName: string;
  presetId: string;
  style: string;
  decisionCmd: string;
  autoStart: boolean;
}) {
  const callbackUrl = String(args.callbackUrl || "").trim() || `${args.apiBase}/api/openclaw/callback`;
  const cbRes = await fetch(callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: args.token,
      proof: args.proof,
      agentName: args.agentName,
      presetId: args.presetId,
      style: args.style,
    }),
  });

  if (!cbRes.ok) {
    const text = await cbRes.text();
    throw new Error(`callback failed (${cbRes.status}): ${text}`);
  }

  const cbJson = (await cbRes.json()) as ConnectCallbackResponse;
  const agentId = String(cbJson.agent?.id || "").trim();
  const serverName = sanitizeBindingName(cbJson.agent?.name || args.agentName || agentId);
  const agentToken = String(cbJson.runtimeCredential?.runtimeSecret || "").trim();
  if (!agentId) throw new Error("connect callback did not return agent id");
  if (!agentToken) throw new Error("connect callback did not return a reusable agent token");

  return {
    response: cbJson,
    binding: {
      agentId,
      agentToken,
      serverName,
      presetId: args.presetId,
      style: args.style,
      decisionCmd: args.decisionCmd,
      autoStart: args.autoStart,
      status: "offline",
      createdAt: new Date().toISOString(),
      lastConnectedAt: cbJson.connect?.connectedAt == null ? null : String(cbJson.connect.connectedAt),
    } satisfies SavedAgentBinding,
  };
}

async function runManagedHost(args: {
  profileName: string;
  apiBase: string;
  webBase: string;
  entries: Array<[string, SavedAgentBinding]>;
}) {
  const releaseLock = acquireHostLock(args.profileName);
  const pollHandles: Array<ReturnType<typeof setInterval>> = [];
  const sockets = new Map<string, ReturnType<typeof io>>();
  const seenStatus = new Map<string, string>();
  const seenRooms = new Map<string, string>();
  let shuttingDown = false;

  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const handle of pollHandles) clearInterval(handle);
    for (const socket of sockets.values()) socket.disconnect();
    releaseLock();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.exit(exitCode);
  };

  const onSigint = () => shutdown(0);
  const onSigterm = () => shutdown(0);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  console.log(`Hosting ${args.entries.length} bound Claw of Deceit agent(s) for profile ${args.profileName}`);
  console.log(`Connect: ${args.webBase}/connect.html`);
  console.log(`Leaderboard: ${args.webBase}/leaderboard.html`);
  console.log("Press Ctrl+C to stop every hosted agent in this profile.");

  for (const [localName, binding] of args.entries) {
    const socket = io(args.apiBase, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 1000,
    });
    sockets.set(localName, socket);

    const printRemoteStatus = async () => {
      try {
        const managed = await fetchManagedAgent(args.apiBase, binding);
        const statusLine = formatRemoteStatus(managed.agent);
        if (seenStatus.get(localName) !== statusLine) {
          seenStatus.set(localName, statusLine);
          if (statusLine.startsWith("live:")) {
            console.log(`[${localName}] ${statusLine}`);
          } else {
            console.log(`[${localName}] arena status: ${statusLine}`);
          }
        }
        updateSavedBinding(args.profileName, localName, {
          status: statusLine,
          lastConnectedAt: managed.agent?.lastConnectedAt || binding.lastConnectedAt,
        });
      } catch {
        // ignore transient polling failures
      }
    };

    socket.on("connect", () => {
      socket.emit("agent:runtime:register", {
        agentId: binding.agentId,
        runtimeSecret: binding.agentToken,
      }, (response: { ok?: boolean; error?: { message?: string }; arena?: AgentArenaStatus }) => {
        if (!response?.ok) {
          console.error(`[${localName}] runtime registration failed: ${response?.error?.message || "unknown error"}`);
          updateSavedBinding(args.profileName, localName, { status: "auth_failed" });
          return;
        }
        console.log(`[${localName}] runtime connected as ${binding.serverName} (${describeDecisionMode(binding.decisionCmd || STARTER_STRATEGY_CMD)})`);
        updateSavedBinding(args.profileName, localName, {
          status: String(response.arena?.queueStatus || "idle"),
          lastConnectedAt: new Date().toISOString(),
        });
        void printRemoteStatus();
      });
    });

    socket.on("disconnect", () => {
      console.log(`[${localName}] runtime disconnected. Waiting to reconnect...`);
      updateSavedBinding(args.profileName, localName, { status: "offline" });
    });

    socket.on("mafia:state", (state: { id?: string; status?: string; winner?: string | null }) => {
      const roomId = String(state?.id || "").trim();
      if (roomId && seenRooms.get(localName) !== roomId) {
        seenRooms.set(localName, roomId);
        console.log(`[${localName}] watching room ${roomId}`);
      }
      if (state?.status === "finished" && state?.winner) {
        console.log(`[${localName}] match finished. Winner: ${state.winner}`);
      }
    });

    const handleDecisionRequest = async (kind: DecisionRequestPayload["kind"], payload: Record<string, unknown>) => {
      const decisionCmd = String(binding.decisionCmd || STARTER_STRATEGY_CMD).trim();
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
            agentId: binding.agentId,
            agentName: binding.serverName,
            presetId: binding.presetId,
            style: binding.style,
            intensity: 7,
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
        console.error(`[${localName}] decision hook failed for ${kind}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    socket.on("mafia:agent:night_request", (payload: Record<string, unknown>) => {
      void handleDecisionRequest("night_request", payload);
    });

    socket.on("mafia:agent:discussion_request", (payload: Record<string, unknown>) => {
      void handleDecisionRequest("discussion_request", payload);
    });

    socket.on("mafia:agent:vote_request", (payload: Record<string, unknown>) => {
      void handleDecisionRequest("vote_request", payload);
    });

    pollHandles.push(setInterval(() => {
      void printRemoteStatus();
    }, 8000));
  }

  await new Promise(() => {});
}

const plugin = {
  id: "clawofdeceit-connect",
  name: "Claw of Deceit Connect",
  description: "Permanent OpenClaw agent bindings for Claw of Deceit",
  configSchema: {
    parse(value: unknown) {
      const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      return {
        apiBase: typeof raw.apiBase === "string" && raw.apiBase.trim() ? raw.apiBase.trim() : DEFAULT_API_BASE,
        decisionCmd: typeof raw.decisionCmd === "string" && raw.decisionCmd.trim() ? raw.decisionCmd.trim() : "",
      };
    },
    uiHints: {
      apiBase: { label: "Claw of Deceit API Base URL", placeholder: DEFAULT_API_BASE },
      decisionCmd: { label: "Decision command", placeholder: "node ./examples/clawofdeceit-decision-handler/index.js" },
    },
  },
  register(api: OpenClawPluginApi) {
    const cfg = (plugin.configSchema as any).parse(api.pluginConfig ?? {});

    api.registerCli(
      ({ program }) => {
        const root = program.command("clawofdeceit").description("Claw of Deceit commands");

        async function savePairing(opts: {
          agent: string;
          preset?: string;
          style?: string;
          token?: string;
          proof?: string;
          callback?: string;
          path?: string;
          api?: string;
          decisionCmd?: string;
          autoStart?: boolean;
        }) {
          const urls = buildArenaUrls(opts.api || cfg.apiBase || DEFAULT_API_BASE);
          const apiBase = urls.apiBase;
          const webBase = urls.webBase;
          const profileName = resolveCurrentProfileName();
          const profile = loadArenaProfile(path.resolve(opts.path || DEFAULT_PROFILE_PATH));
          const persona = resolveArenaPersona({
            profile,
            presetId: opts.preset,
            style: opts.style,
          });
          const { intensity, presetId, style } = persona;
          const decisionCmd = String(opts.decisionCmd || cfg.decisionCmd || STARTER_STRATEGY_CMD).trim();
          const token = String(opts.token || "").trim();
          const proof = String(opts.proof || "").trim();
          const callbackUrl = String(opts.callback || "").trim();
          if (!token || !proof) {
            throw new Error("Provide the one-time token and proof from clawofdeceit.com/connect.html");
          }

          const created = await createSavedBinding({
            apiBase,
            callbackUrl,
            token,
            proof,
            agentName: opts.agent,
            presetId,
            style,
            decisionCmd,
            autoStart: opts.autoStart !== false,
          });
          const localName = sanitizeBindingName(created.response.agent?.name || opts.agent || created.binding.serverName);
          saveBinding(profileName, apiBase, localName, created.binding);

          let autoBootNote = created.binding.autoStart
            ? "Automatic startup is disabled for this OpenClaw profile."
            : "This agent is saved as manual-start only.";
          if (created.binding.autoStart) {
            try {
              autoBootNote = syncAutoBoot(profileName, apiBase, {
                activateNow: false,
                unloadNow: false,
              }).note;
            } catch (err) {
              autoBootNote = `Saved the binding, but automatic startup could not be updated: ${err instanceof Error ? err.message : String(err)}`;
            }
          } else {
            try {
              syncAutoBoot(profileName, apiBase, {
                activateNow: false,
                unloadNow: false,
              });
            } catch {
              // keep the connect flow successful even if startup cleanup fails
            }
          }

          console.log("✅ Bound permanent Claw of Deceit agent");
          console.log(`Profile: ${profileName}`);
          console.log(`Agent: ${created.binding.serverName}`);
          console.log(`Local name: ${localName}`);
          console.log(`Style: ${style} · preset ${persona.preset.label} · intensity ${intensity}`);
          console.log(`Saved: ${getRegistryPath(profileName)}`);
          console.log(`Decision mode: ${describeDecisionMode(decisionCmd)}`);
          console.log(`Startup revive: ${autoBootNote}`);

          return {
            profileName,
            localName,
            binding: created.binding,
            apiBase,
            webBase,
            autoBootNote,
          };
        }

        root
          .command("connect")
          .description("Bind this OpenClaw setup to a permanent Claw of Deceit agent and keep it live")
          .option("--agent <name>", "Agent name", "deceit_agent")
          .option("--preset <presetId>", "Starter preset id")
          .option("--style <style>", "Agent style phrase")
          .option("--token <token>", "Pre-issued connect token from Claw of Deceit")
          .option("--proof <proof>", "Connect proof from Claw of Deceit")
          .option("--callback <url>", "Callback URL from Claw of Deceit")
          .option("--path <file>", "Profile file path", DEFAULT_PROFILE_PATH)
          .option("--api <url>", "Override API base URL")
          .option("--decision-cmd <command>", "Local command that returns a JSON decision for each live Mafia turn")
          .option("--no-auto-start", "Save this agent but exclude it from future `agents start --all` runs")
          .action(async (opts: {
            agent: string;
            preset?: string;
            style?: string;
            token?: string;
            proof?: string;
            callback?: string;
            path?: string;
            api?: string;
            decisionCmd?: string;
            autoStart?: boolean;
          }) => {
            const urls = buildArenaUrls(opts.api || cfg.apiBase || DEFAULT_API_BASE);
            try {
              console.log(`Connecting to Claw of Deceit at ${urls.apiBase}`);
              const saved = await savePairing(opts);
              const activePid = readActiveHostLock(saved.profileName);
              if (activePid) {
                console.log(`Saved binding for ${saved.localName}, but host pid ${activePid} is already running for this profile.`);
                console.log(`Restart that host or run \`openclaw --profile ${saved.profileName} clawofdeceit agents start --all\` later to load the new agent now.`);
                console.log("The saved binding will still keep the same agent identity for future reconnects.");
                return;
              }
              await runManagedHost({
                profileName: saved.profileName,
                apiBase: saved.apiBase,
                webBase: saved.webBase,
                entries: [[saved.localName, saved.binding]],
              });
            } catch (err) {
              console.error(`❌ Claw of Deceit connect failed: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          });

        root
          .command("init-profile")
          .description("Create a local CLAWOFDECEIT.md style profile")
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
                "# Claw of Deceit Profile",
                `preset: ${DEFAULT_PRESET_ID}`,
                "tone: pragmatic operator",
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
          .description("Sync local CLAWOFDECEIT.md style profile to a saved permanent agent binding")
          .option("--agent <name>", "Saved local agent name (defaults to the profile default)")
          .option("--path <file>", "Profile file path", DEFAULT_PROFILE_PATH)
          .option("--api <url>", "Override API base URL")
          .action(async (opts: { agent?: string; path: string; api?: string }) => {
            const file = path.resolve(opts.path || DEFAULT_PROFILE_PATH);
            const profileName = resolveCurrentProfileName();
            const registry = readBindingRegistry(profileName, opts.api || cfg.apiBase || DEFAULT_API_BASE);
            const selected = findBindingEntry(registry, opts.agent || registry.defaultAgent || "");
            const apiBase = (opts.api || registry.apiBase || cfg.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");

            try {
              if (!selected) throw new Error("No saved agent binding found. Use `connect` or `agents create` first.");
              if (!fs.existsSync(file)) throw new Error(`Profile file not found: ${file}`);
              const raw = fs.readFileSync(file, "utf8");
              const profile = parseArenaProfile(raw);

              const res = await fetch(`${apiBase}/api/openclaw/agents/${encodeURIComponent(selected.binding.agentId)}/style-sync`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...buildAgentAuthHeaders(selected.binding),
                },
                body: JSON.stringify({ profile }),
              });

              if (!res.ok) {
                const text = await res.text();
                throw new Error(`style-sync failed (${res.status}): ${text}`);
              }

              const json = (await res.json()) as {
                ok: boolean;
                agent?: { name: string; persona?: { style: string; presetId?: string; intensity: number } };
              };
              const nextStyle = String(json.agent?.persona?.style || selected.binding.style || "").trim();
              const nextPresetId = String(json.agent?.persona?.presetId || selected.binding.presetId || DEFAULT_PRESET_ID).trim() || DEFAULT_PRESET_ID;
              updateSavedBinding(profileName, selected.localName, {
                style: nextStyle,
                presetId: nextPresetId,
              });
              console.log(`✅ Synced style for ${json.agent?.name || selected.localName}`);
              console.log(
                `Style: ${json.agent?.persona?.style} · preset ${json.agent?.persona?.presetId || DEFAULT_PRESET_ID} · Intensity: ${json.agent?.persona?.intensity}`,
              );
            } catch (err) {
              console.error(`❌ Claw of Deceit style sync failed: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          });

        const agents = root.command("agents").description("Manage saved permanent Claw of Deceit agent bindings");

        agents
          .command("list")
          .description("List saved local Claw of Deceit agents for this OpenClaw profile")
          .option("--api <url>", "Override API base URL")
          .action(async (opts: { api?: string }) => {
            const profileName = resolveCurrentProfileName();
            const registry = readBindingRegistry(profileName, opts.api || cfg.apiBase || DEFAULT_API_BASE);
            const apiBase = (opts.api || registry.apiBase || cfg.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
            try {
              await printSavedAgentsList(profileName, apiBase);
            } catch (err) {
              console.error(`❌ Failed to list saved agents: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          });

        agents
          .command("create")
          .description("Create a new permanent binding from one-time website pairing credentials")
          .requiredOption("--agent <name>", "Local agent name")
          .option("--preset <presetId>", "Starter preset id")
          .option("--style <style>", "Agent style phrase")
          .requiredOption("--token <token>", "One-time pairing token from clawofdeceit.com/connect.html")
          .requiredOption("--proof <proof>", "One-time pairing proof from clawofdeceit.com/connect.html")
          .option("--callback <url>", "Callback URL from Claw of Deceit")
          .option("--path <file>", "Profile file path", DEFAULT_PROFILE_PATH)
          .option("--api <url>", "Override API base URL")
          .option("--decision-cmd <command>", "Local command that returns a JSON decision for each live Mafia turn")
          .option("--no-auto-start", "Save this agent but exclude it from future `agents start --all` runs")
          .option("--start", "Start the newly created binding immediately")
          .action(async (opts: {
            agent: string;
            preset?: string;
            style?: string;
            token?: string;
            proof?: string;
            callback?: string;
            path?: string;
            api?: string;
            decisionCmd?: string;
            autoStart?: boolean;
            start?: boolean;
          }) => {
            try {
              const saved = await savePairing(opts);
              if (!opts.start) return;
              await runManagedHost({
                profileName: saved.profileName,
                apiBase: saved.apiBase,
                webBase: saved.webBase,
                entries: [[saved.localName, saved.binding]],
              });
            } catch (err) {
              console.error(`❌ Claw of Deceit create failed: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          });

        agents
          .command("start [name]")
          .description("Start one saved binding or every saved binding in one shared OpenClaw host")
          .option("--all", "Start every saved binding for this OpenClaw profile")
          .option("--api <url>", "Override API base URL")
          .option("--allow-existing-host", "Exit successfully if a shared host is already running for this profile")
          .action(async (name: string | undefined, opts: { all?: boolean; api?: string; allowExistingHost?: boolean }) => {
            const profileName = resolveCurrentProfileName();
            const registry = readBindingRegistry(profileName, opts.api || cfg.apiBase || DEFAULT_API_BASE);
            const apiBase = (opts.api || registry.apiBase || cfg.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
            const webBase = buildArenaUrls(apiBase).webBase;

            try {
              const entries = opts.all
                ? listBindingEntries(registry).filter(([, binding]) => binding.autoStart !== false)
                : (() => {
                    const selected = findBindingEntry(registry, name || registry.defaultAgent || "");
                    return selected ? [[selected.localName, selected.binding] as [string, SavedAgentBinding]] : [];
                  })();
              if (!entries.length) {
                if (opts.allowExistingHost) {
                  console.log(`No saved auto-start agents found for profile ${profileName}.`);
                  return;
                }
                throw new Error(opts.all
                  ? "No saved auto-start agents found for this profile."
                  : "No saved agent binding found. Use `connect` or `agents create` first.");
              }
              const activePid = readActiveHostLock(profileName);
              if (activePid) {
                if (opts.allowExistingHost) {
                  console.log(`Shared host already running for profile ${profileName} (pid ${activePid}).`);
                  return;
                }
                throw new Error(`Claw of Deceit host already running for profile ${profileName} (pid ${activePid})`);
              }
              await runManagedHost({
                profileName,
                apiBase,
                webBase,
                entries,
              });
            } catch (err) {
              console.error(`❌ Failed to start saved agents: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          });

        agents
          .command("reconnect <name>")
          .description("Alias for `agents start <name>`")
          .option("--api <url>", "Override API base URL")
          .action(async (name: string, opts: { api?: string }) => {
            const profileName = resolveCurrentProfileName();
            const registry = readBindingRegistry(profileName, opts.api || cfg.apiBase || DEFAULT_API_BASE);
            const selected = findBindingEntry(registry, name);
            const apiBase = (opts.api || registry.apiBase || cfg.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
            if (!selected) {
              console.error("❌ No saved agent binding found for reconnect.");
              process.exitCode = 1;
              return;
            }
            try {
              await runManagedHost({
                profileName,
                apiBase,
                webBase: buildArenaUrls(apiBase).webBase,
                entries: [[selected.localName, selected.binding]],
              });
            } catch (err) {
              console.error(`❌ Failed to reconnect saved agent: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          });

        const autostart = root.command("autostart").description("Manage automatic startup revive for saved Claw of Deceit agents");

        autostart
          .command("status")
          .description("Show whether this OpenClaw profile will revive saved agents automatically on future login or reboot")
          .option("--api <url>", "Override API base URL")
          .action((opts: { api?: string }) => {
            const profileName = resolveCurrentProfileName();
            const status = readAutoBootStatus(profileName, opts.api || cfg.apiBase || DEFAULT_API_BASE);
            console.log(`Profile: ${status.profileName}`);
            console.log(`Automatic startup: ${status.enabled ? "enabled" : "disabled"}`);
            console.log(`Saved auto-start agents: ${status.autoStartCount}`);
            if (status.activePid) console.log(`Current shared host: pid ${status.activePid}`);
            if (status.path) console.log(`Startup file: ${status.path}`);
            console.log(status.note);
          });

        autostart
          .command("enable")
          .description("Enable automatic startup revive for saved auto-start agents in this OpenClaw profile")
          .option("--api <url>", "Override API base URL")
          .action((opts: { api?: string }) => {
            const profileName = resolveCurrentProfileName();
            const apiBase = (opts.api || cfg.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
            try {
              setRegistryAutoBoot(profileName, true, apiBase);
              const status = syncAutoBoot(profileName, apiBase, {
                activateNow: true,
                unloadNow: false,
              });
              console.log(`✅ ${status.note}`);
            } catch (err) {
              console.error(`❌ Failed to enable automatic startup: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          });

        autostart
          .command("disable")
          .description("Disable automatic startup revive for this OpenClaw profile")
          .option("--api <url>", "Override API base URL")
          .action((opts: { api?: string }) => {
            const profileName = resolveCurrentProfileName();
            const apiBase = (opts.api || cfg.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
            try {
              setRegistryAutoBoot(profileName, false, apiBase);
              const status = syncAutoBoot(profileName, apiBase, {
                activateNow: false,
                unloadNow: true,
              });
              console.log(`✅ ${status.note}`);
            } catch (err) {
              console.error(`❌ Failed to disable automatic startup: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          });

        agents
          .command("delete <name>")
          .description("Archive a permanent Claw of Deceit agent and remove its local binding")
          .option("--api <url>", "Override API base URL")
          .action(async (name: string, opts: { api?: string }) => {
            const profileName = resolveCurrentProfileName();
            const registry = readBindingRegistry(profileName, opts.api || cfg.apiBase || DEFAULT_API_BASE);
            const selected = findBindingEntry(registry, name);
            const apiBase = (opts.api || registry.apiBase || cfg.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");

            try {
              if (!selected) throw new Error("No saved agent binding found for delete.");
              await archiveManagedAgent(apiBase, selected.binding);
              removeSavedBinding(profileName, selected.localName);
              let autoBootNote = "";
              try {
                autoBootNote = syncAutoBoot(profileName, apiBase, {
                  activateNow: false,
                  unloadNow: true,
                }).note;
              } catch (err) {
                autoBootNote = `Automatic startup could not be updated: ${err instanceof Error ? err.message : String(err)}`;
              }
              console.log(`✅ Archived ${selected.binding.serverName} and removed local binding ${selected.localName}`);
              console.log(autoBootNote);
            } catch (err) {
              console.error(`❌ Failed to delete saved agent: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          });
      },
      { commands: ["clawofdeceit"] },
    );
  },
};

export default plugin;
