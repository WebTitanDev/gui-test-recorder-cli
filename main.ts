/// <reference lib="deno.ns" />
// main.ts
// PoC: GUI Test Recorder CLI (Deno 2 + Playwright)
// - GUI only (headed)
// - Stores everything under tests/
// - Works with global `playwright` OR `npx playwright` (auto-detect)
// - You can force mode with env: PLAYWRIGHT_MODE=global|npx
//   Optional: PLAYWRIGHT_BIN=... , NPX_BIN=... , NODE_BIN=...

// Load .env values into Deno.env (optional but recommended)
import "https://deno.land/std@0.224.0/dotenv/load.ts";
Deno.env.set("PLAYWRIGHT_TRACE_VIEWER_HOST", "127.0.0.1");

import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";
import { exists } from "https://deno.land/std@0.224.0/fs/exists.ts";
import {
  Confirm,
  Input,
  Number as NumberPrompt,
  Select,
} from "https://deno.land/x/cliffy@v1.0.0-rc.3/prompt/mod.ts";

type DeviceType = "pc" | "mobile";
type HistoryEntry = {
  id: string;
  url: string;
  device: DeviceType;
  createdAt: string;
  feedback: string;
  scriptPath: string;
  tracePath: string;
};

const TESTS_DIR = "tests";
const SESSIONS_DIR = `${TESTS_DIR}/sessions`;
const HISTORY_PATH = `${TESTS_DIR}/history.json`;

const isWindows = Deno.build.os === "windows";
const defaultNPX = Deno.env.get("NPX_BIN") ?? (isWindows ? "npx.cmd" : "npx");
const defaultPlaywright = Deno.env.get("PLAYWRIGHT_BIN") ??
  (isWindows ? "playwright.cmd" : "playwright");
const defaultNode = Deno.env.get("NODE_BIN") ?? (isWindows ? "node.exe" : "node");

// ---------- small utils ----------
async function run(cmd: string, args: string[]) {
  const env = {
    ...Deno.env.toObject(),
    PLAYWRIGHT_TRACE_VIEWER_HOST: "127.0.0.1",
    PLAYWRIGHT_FORCE_IPV4: "1",
  };

  console.log(`Running command: ${cmd} ${args.join(" ")}`);
  console.log(`With env: ${JSON.stringify(env)}`);

  const p = new Deno.Command(cmd, {
    args,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const { code } = await p.spawn().status;
  if (code !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}`);
  }
}

async function whichOk(cmd: string): Promise<boolean> {
  try {
    const p = new Deno.Command(cmd, { args: ["--version"], stdout: "null", stderr: "null" });
    const { code } = await p.output();
    return code === 0;
  } catch {
    return false;
  }
}

type PwInvoker =
  | { mode: "global"; cmd: string; wrap: (a: string[]) => string[] }
  | { mode: "npx"; cmd: string; wrap: (a: string[]) => string[] };

async function resolvePlaywright(): Promise<PwInvoker> {
  const mode = Deno.env.get("PLAYWRIGHT_MODE"); // "global" | "npx" | undefined

  async function tryGlobal(): Promise<PwInvoker | null> {
    if (await whichOk(defaultPlaywright)) {
      return {
        mode: "global",
        cmd: defaultPlaywright,
        wrap: (a) => a,
      };
    }
    return null;
  }
  async function tryNpx(): Promise<PwInvoker | null> {
    if (await whichOk(defaultNPX)) {
      return { mode: "npx", cmd: defaultNPX, wrap: (a) => ["playwright", ...a] };
    }
    return null;
  }

  if (mode === "global") {
    const g = await tryGlobal();
    if (!g) {
      throw new Error(
        "PLAYWRIGHT_MODE=global but `playwright` not found. Install it or set PLAYWRIGHT_BIN.",
      );
    }
    return g;
  }
  if (mode === "npx") {
    const n = await tryNpx();
    if (!n) throw new Error("PLAYWRIGHT_MODE=npx but `npx` not found on PATH.");
    return n;
  }
  // Auto-detect: prefer global, fallback to npx
  return (await tryGlobal()) ?? (await tryNpx()) ?? (() => {
    throw new Error("Could not find Playwright (global) or npx. Install Node+npx or set env vars.");
  })();
}

async function loadHistory(): Promise<HistoryEntry[]> {
  if (!(await exists(HISTORY_PATH))) return [];
  try {
    const txt = await Deno.readTextFile(HISTORY_PATH);
    const data = JSON.parse(txt);
    return Array.isArray(data) ? (data as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

async function saveHistory(entries: HistoryEntry[]) {
  await ensureDir(TESTS_DIR);
  await Deno.writeTextFile(HISTORY_PATH, JSON.stringify(entries, null, 2));
}

function newId(): string {
  // PoC requirement: timestamp or hardcoded UUID
  return `${Date.now()}`;
}

function isDeviceType(x: string): x is DeviceType {
  return x === "pc" || x === "mobile";
}

function devicePreset(device: DeviceType): string {
  // Map our logical device to a Playwright device preset
  return device === "mobile" ? "iPhone 13" : "Desktop Chrome";
}

// ---------- record ----------
async function recordNewTest() {
  const pw = await resolvePlaywright();

  const url = await Input.prompt({
    message: "Enter target URL",
    default: "https://example.com",
  });

  const rawDevice = await Select.prompt({
    message: "Select device type",
    options: [
      { name: "pc", value: "pc" },
      { name: "mobile", value: "mobile" },
    ],
  });

  if (!isDeviceType(rawDevice)) {
    throw new Error(`Invalid device selection: ${rawDevice}`);
  }
  const device: DeviceType = rawDevice;

  const id = newId();
  const sessionDir = `${SESSIONS_DIR}/${id}`;
  await ensureDir(sessionDir);

  const scriptPath = `${sessionDir}/script.spec.ts`;
  const tracePath = `${sessionDir}/trace.zip`;
  const preset = devicePreset(device);

  console.log("\nStarting Playwright codegen (headed). Close the window when finished...");
  await run(pw.cmd, pw.wrap(["codegen", url, "--output", scriptPath, "--device", preset]));

  // Optional trace generation (headed) so show-trace works even without a full test run
  const gen = await Confirm.prompt("Generate a short GUI trace for replay now?");
  if (gen) {
    const traceGenJs = `${sessionDir}/tracegen.js`;
    const js = `
      const { chromium, devices } = require('playwright');
      (async () => {
        const preset = ${JSON.stringify(preset)};
        const url = ${JSON.stringify(url)};
        const dev = devices[preset];
        const browser = await chromium.launch({ headless: false });
        const context = await browser.newContext(dev ? { ...dev } : {});
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(12000);
        await context.tracing.stop({ path: ${JSON.stringify(tracePath)} });
        await browser.close();
      })().catch(e => { console.error(e); process.exit(1); });
      `.trimStart();
    await Deno.writeTextFile(traceGenJs, js);
    console.log("Generating trace (headed)...");
    await run(defaultNode, [traceGenJs]); // requires `npm i -D playwright` once
  } else {
    console.log("Skipping trace generation. You can add one later.");
  }

  const feedback = await Input.prompt({ message: "Feedback/notes (optional)", default: "" });

  const entry: HistoryEntry = {
    id,
    url,
    device,
    createdAt: new Date().toISOString(),
    feedback,
    scriptPath,
    tracePath,
  };

  const history = await loadHistory();
  history.push(entry);
  await saveHistory(history);

  console.log("\n✅ Saved session");
  console.log(`- ID:     ${id}`);
  console.log(`- Script: ${scriptPath}`);
  console.log(`- Trace:  ${await exists(tracePath) ? tracePath : "(not generated)"}`);
  console.log(`- Log:    ${HISTORY_PATH}\n`);
}

// ---------- replay ----------
async function replayTest() {
  const pw = await resolvePlaywright();
  const entries = await loadHistory();
  if (!entries.length) {
    console.log("\nNo sessions found. Record one first.\n");
    return;
  }

  console.log("\nAvailable sessions:\n");
  entries.forEach((e, i) => {
    console.log(`${i + 1}. [${e.id}] ${e.url} | device=${e.device} | createdAt=${e.createdAt}`);
  });
  console.log("");

  const pickStr = await Input.prompt({
    message: `Pick a session (1-${entries.length})`,
    default: `${entries.length}`,
  });
  const idx = Math.max(1, Math.min(entries.length, Number(pickStr))) - 1;
  const chosen = entries[idx];

  if (!(await exists(chosen.tracePath))) {
    console.log(`\n⚠ No trace found for session ${chosen.id} at ${chosen.tracePath}`);
    console.log(
      "Tip: Re-generate a trace when recording, or place a trace.zip into that folder.\n",
    );
    return;
  }

  const n = await NumberPrompt.prompt({
    message: "How many trace viewers to open?",
    default: 1,
    min: 1,
    max: 10,
  });

  console.log(`\nOpening ${n} Trace Viewer instance(s)...`);
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    jobs.push(run(pw.cmd, pw.wrap(["show-trace", chosen.tracePath])));
  }
  await Promise.all(jobs);
  console.log("\n✅ Replay complete.\n");
}

// ---------- menu ----------
async function mainMenu() {
  await ensureDir(SESSIONS_DIR);
  if (!(await exists(HISTORY_PATH))) await saveHistory([]);

  while (true) {
    const choice = await Select.prompt({
      message: "GUI Test Recorder CLI (PoC)",
      options: [
        { name: "1. Record new test", value: "record" },
        { name: "2. Replay a test", value: "replay" },
        { name: "3. Exit", value: "exit" },
      ],
    });

    try {
      if (choice === "record") await recordNewTest();
      else if (choice === "replay") await replayTest();
      else return;
    } catch (e) {
      if (e instanceof Error) {
        console.error("\n❌ Error:", e.message);
      } else {
        console.error("\n❌ Error:", e);
      }
      console.error(
        "Hint: Ensure Node + Playwright are installed. Set PLAYWRIGHT_MODE=npx if you prefer npx.\n",
      );
    }
  }
}

if (import.meta.main) {
  await mainMenu();
}
