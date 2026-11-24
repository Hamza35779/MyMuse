#!/usr/bin/env node
// Prints which credentials are already configured and which are still missing.
// Values are never printed, only whether a key or secret exists.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localOnly = process.argv.includes("--local-only");

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

function readJson(file) {
  const text = read(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function run(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

const envFile = parseEnv(read(".env"));
const appJson = readJson("apps/mobile/app.json");
const easJson = readJson("apps/mobile/eas.json");
const projectId = appJson?.expo?.extra?.eas?.projectId;
const hasProductionProfile = Boolean(easJson?.build?.production);

const remote = run("git", ["remote", "get-url", "origin"]);
const slug = remote ? /github\.com[:/]+([^/]+)\/([^/.\s]+)/.exec(remote.trim()) : null;
const repo = slug ? `${slug[1]}/${slug[2]}` : null;

// Repository secrets can only be listed with admin rights on the repo. A token
// without them is reported as unreadable rather than as "missing".
let repoSecrets = null;
if (repo && run("gh", ["--version"])) {
  const listed = run("gh", ["secret", "list", "-R", repo, "--json", "name", "--jq", ".[].name"]);
  if (listed !== null)
    repoSecrets = new Set(
      listed
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
}

const sections = [];

function secret(name, fix) {
  const local = envFile.has(name) || Boolean(process.env[name]);
  const remoteKnown = repoSecrets?.has(name) ?? false;
  return {
    name,
    state: remoteKnown ? "ready" : local ? "local" : repoSecrets ? "missing" : "unknown",
    fix,
  };
}

function local(name, fix, required = true) {
  const present = envFile.has(name) || Boolean(process.env[name]);
  return { name, state: present ? "ready" : required ? "missing" : "optional", fix };
}

sections.push({
  title: "Local sample workspace",
  intro: "Needed for `pnpm dev` and for the conversation to load in the app.",
  items: [
    {
      name: ".env",
      state: existsSync(join(root, ".env"))
        ? "ready"
        : process.env.CPK_INTELLIGENCE_API_KEY
          ? "ready"
          : "missing",
      fix: "cp .env.example .env",
    },
    local(
      "CPK_INTELLIGENCE_API_KEY",
      "npx copilotkit@latest login && npx copilotkit@latest project select  (then paste the key into .env)",
    ),
    local(
      "CPK_TELEMETRY_ID",
      "written by `npx copilotkit@latest project select`; keep the generated value",
      false,
    ),
  ],
});

if (!localOnly) {
  sections.push({
    title: "Store builds on GitHub Actions",
    intro: "Needed for the production profile and the `submit` job in release.yml.",
    items: [
      secret("EXPO_TOKEN", "https://expo.dev/settings/access-tokens -> Create token"),
      {
        name: "expo.extra.eas.projectId",
        state: projectId ? "ready" : "missing",
        fix: "npx eas-cli login && npx eas-cli init  (in apps/mobile, then commit app.json)",
      },
      {
        name: "build.production profile",
        state: hasProductionProfile ? "ready" : "missing",
        fix: "apps/mobile/eas.json is missing its production profile",
      },
      secret("EXPO_APPLE_ID", "the email of your paid Apple Developer account"),
      secret(
        "EXPO_APPLE_APP_SPECIFIC_PASSWORD",
        "https://appleid.apple.com -> Sign-In and Security -> App-Specific Passwords",
      ),
      secret(
        "EXPO_APPLE_TEAM_ID",
        "https://developer.apple.com/account -> Membership details -> Team ID",
      ),
      secret("EXPO_ASC_APP_ID", "App Store Connect -> your app -> App Information -> Apple ID"),
      secret(
        "PLAY_SERVICE_ACCOUNT_JSON",
        "Play Console -> Setup -> API access -> service account JSON key",
      ),
    ],
  });

  sections.push({
    title: "APK smoke test",
    intro: "Runs in Actions; without the key it only proves the APK reached the API.",
    items: [
      secret(
        "CPK_INTELLIGENCE_API_KEY",
        "npx copilotkit@latest login && npx copilotkit@latest project select",
      ),
    ],
  });
}

const glyph = {
  ready: "\u2714",
  local: "\u25d1",
  missing: "\u2718",
  optional: "\u00b7",
  unknown: "?",
};
const note = {
  ready: "set",
  local: "in .env only",
  missing: "missing",
  optional: "not set (optional)",
  unknown: "unreadable",
};

let missing = 0;
for (const section of sections) {
  console.log(`\n${section.title}`);
  console.log(`  ${section.intro}`);
  for (const item of section.items) {
    if (item.state === "missing") missing += 1;
    console.log(`  ${glyph[item.state]} ${item.name.padEnd(34)} ${note[item.state]}`);
    if (item.state !== "ready") console.log(`      ${item.fix}`);
  }
}

if (!localOnly) {
  console.log(
    "\nSigning material (Android keystore, iOS certificate and profile) lives on Expo's servers;",
  );
  console.log(
    "create it once with `npx eas-cli credentials` in apps/mobile. It cannot be checked from here.",
  );

  if (repoSecrets === null) {
    console.log(
      `\nRepository secrets on ${repo ?? "origin"} could not be read with the current \`gh\` token;`,
    );
    console.log(
      "values shown as `in .env only` exist locally but may be absent from the repository.",
    );
    console.log(`Add them at https://github.com/${repo ?? "OWNER/REPO"}/settings/secrets/actions`);
  } else {
    console.log(
      `\nRepository secrets are read from https://github.com/${repo}/settings/secrets/actions`,
    );
  }
}

if (missing > 0) {
  console.log(
    `\n${missing} item${missing === 1 ? "" : "s"} still missing. See README.md, "Quick start".`,
  );
  process.exitCode = 1;
} else {
  console.log("\nEverything checked here is configured.");
}
