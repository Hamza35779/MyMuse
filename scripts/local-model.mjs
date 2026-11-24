#!/usr/bin/env node
// Runs the chat on a model that lives on your machine: no account, no key, no billing.
// Starts Ollama if it is installed, downloads the requested model, and optionally
// writes the resulting OPENAI_* settings into .env.
//
//   pnpm model:local                 # check or set up, keep .env untouched
//   pnpm model:local --write-env     # also point .env at the local model
//   pnpm model:local --model qwen2.5:7b
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
};
const writeEnv = args.includes("--write-env");
// 1.5B is the largest tier that answers on a 2-core CPU box with ~3 GB free.
const defaultModel = "qwen2.5:1.5b";
const model = flag("--model") ?? defaultModel;

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: pnpm model:local [--write-env] [--model <ollama-model>]

Checks for a local OpenAI-compatible server, starts Ollama when it is installed,
downloads the model, and confirms it answers. --write-env also updates .env.

Default model: ${defaultModel}`);
  process.exit(0);
}

function read(file) {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return null;
  }
}

function parseEnv(text) {
  const values = new Map();
  for (const line of (text ?? "").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (value) values.set(match[1], value);
  }
  return values;
}

const env = parseEnv(read(".env"));
const baseUrl = env.get("OPENAI_BASE_URL") ?? "http://127.0.0.1:11434/v1";

async function request(path, init = {}) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/v1\/?$/, "")}${path}`, {
      ...init,
      signal: AbortSignal.timeout(init.timeout ?? 5000),
    });
    return response;
  } catch {
    return null;
  }
}

async function models() {
  const response = await request("/v1/models");
  if (!response?.ok) return null;
  const body = await response.json().catch(() => null);
  return (body?.data ?? []).map((entry) => entry.id).filter(Boolean);
}

function haveOllama() {
  try {
    return execFileSync("ollama", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
  } catch {
    return null;
  }
}

const installed = haveOllama();
let available = await models();

if (!available) {
  if (!installed) {
    console.error(`${baseUrl} is not answering and Ollama is not installed.\n
Pick one:
  Linux          curl -fsSL https://ollama.com/install.sh | sh
  macOS / Windows  https://ollama.com/download
  LM Studio      https://lmstudio.ai  (start its local server on port 1234)

Then run this command again. Any OpenAI-compatible server works: set
OPENAI_BASE_URL to its /v1 endpoint and OPENAI_CHAT_COMPLETIONS=true.`);
    process.exit(1);
  }
  console.log(`Starting Ollama (${installed.trim()})…`);
  const server = spawn("ollama", ["serve"], { detached: true, stdio: "ignore" });
  server.unref();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    available = await models();
    if (available) break;
  }
  if (!available) {
    console.error(`Ollama did not answer at ${baseUrl}. Start it yourself with:
  ollama serve`);
    process.exit(1);
  }
}

if (!available.some((id) => id === model || id.startsWith(`${model}:`))) {
  console.log(`Downloading ${model}…`);
  const pull = spawnSync("ollama", ["pull", model], { cwd: root, stdio: "inherit" });
  if (pull.status !== 0) process.exit(pull.status ?? 1);
  available = (await models()) ?? [];
}

console.log(`\nLocal models: ${available.join(", ") || "none"}`);
const configured = env.get("MODEL");
const target = `openai/${model}`;
if (configured && configured !== target)
  console.log(`.env MODEL is ${configured}; this setup uses ${target}.`);

process.stdout.write("Asking the model for a reply… ");
const reply = await request("/v1/chat/completions", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${env.get("OPENAI_API_KEY") ?? "ollama"}`,
  },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply in one short sentence: it works." }],
    max_tokens: 40,
  }),
  timeout: 180_000,
});
const body = reply?.ok ? await reply.json().catch(() => null) : null;
const text = body?.choices?.[0]?.message?.content?.trim();
if (!text) {
  console.error(`failed.\n${baseUrl} accepted the model but returned no text.`);
  process.exit(1);
}
console.log(`ok: “${text}”`);

if (!writeEnv) {
  console.log(`\nAdd these to .env to use it (or rerun with --write-env):
  AGENT_BACKEND=model
  MODEL=${target}
  OPENAI_API_KEY=ollama
  OPENAI_BASE_URL=${baseUrl}
  OPENAI_CHAT_COMPLETIONS=true`);
  process.exit(0);
}

const desired = [
  ["AGENT_BACKEND", "model"],
  ["MODEL", target],
  ["OPENAI_API_KEY", env.get("OPENAI_API_KEY") ?? "ollama"],
  ["OPENAI_BASE_URL", baseUrl],
  ["OPENAI_CHAT_COMPLETIONS", "true"],
];
const existing = read(".env");
if (existing === null) {
  console.error("\nNo .env found. Copy .env.example to .env first.");
  process.exit(1);
}
let updated = existing;
for (const [key, value] of desired) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*#?\\s*${key}\\s*=.*$`, "m");
  updated = pattern.test(updated)
    ? updated.replace(pattern, line)
    : `${updated.replace(/\n?$/, "\n")}${line}\n`;
}
if (updated !== existing) writeFileSync(join(root, ".env"), updated);
console.log(`\nUpdated .env: AGENT_BACKEND=model, MODEL=${target}. Restart the API to use it.`);
