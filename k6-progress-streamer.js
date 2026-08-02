#!/usr/bin/env node
"use strict";

/**
 * k6-progress-streamer.js
 * ------------------------------------------------------------------------
 * Sidecar for the k6-demo Jenkins job. Tails k6's own streaming JSON output
 * (`k6 run --out json=<file> ...`) while the test executes, buckets samples
 * into fixed-width time windows, and POSTs one summarized point per window
 * to the Costco Travel Engineering Portal's incremental-progress endpoint --
 * so the run's live latency (p50/p90/p95/p99) + RPS chart fills in as the
 * test runs, instead of only appearing once at the very end.
 *
 * This is a companion to the existing one-shot end-of-test summary POST
 * (K6PortalResult -> `${PORTAL_CALLBACK_URL}`) that k6-demo already sends.
 * That POST is unchanged -- this script is purely additive.
 *
 * HOW TO WIRE THIS INTO THE JENKINS JOB
 * ------------------------------------------------------------------------
 * 1. Drop this file into the k6-demo repository (e.g. at the repo root,
 *    alongside test.js).
 *
 * 2. Add a new Jenkins Freestyle build parameter: PORTAL_PROGRESS_URL.
 *    The portal already passes this automatically on every triggered run
 *    (see lib/integrations/jenkins-client.ts / K6DemoBuildParameters) --
 *    you only need to declare the parameter on the Jenkins job so it's
 *    accepted and exposed as an environment variable to the build steps.
 *
 * 3. Change the k6 invocation to also write a streaming JSON output file:
 *
 *      k6 run --out json=k6-stream.json test.js
 *
 *    (in addition to whatever summary-export flag you already use for the
 *    final K6PortalResult POST -- that part of the job does not change).
 *
 * 4. Start this script in the BACKGROUND right before (or immediately
 *    after) launching k6, pointed at that same file, e.g. as an additional
 *    "Execute shell" build step:
 *
 *      node k6-progress-streamer.js --file k6-stream.json &
 *      STREAMER_PID=$!
 *      k6 run --out json=k6-stream.json test.js
 *      kill "$STREAMER_PID" 2>/dev/null || true
 *
 *    The script tails the file as k6 appends to it and exits on its own
 *    shortly after k6 finishes writing (idle timeout), so the explicit
 *    `kill` above is just a safety net.
 *
 * 5. Required environment variables (Jenkins already sets RUN_ID and
 *    PORTAL_PROGRESS_URL as build parameters once step 2 is done):
 *
 *      RUN_ID                     -- from the RUN_ID build parameter
 *      PORTAL_PROGRESS_URL        -- from the PORTAL_PROGRESS_URL build parameter
 *      PERFORMANCE_CALLBACK_SECRET -- same shared secret the final results
 *                                      POST already uses (Bearer token)
 *
 *    Optional:
 *      WINDOW_SECONDS             -- bucket width, default 5
 *      RAMP_UP_SECONDS / STEADY_SECONDS / RAMP_DOWN_SECONDS
 *                                 -- total expected duration, used only to
 *                                    compute the optional progressPercent
 *                                    field (defaults to no estimate if unset)
 *
 * REQUIREMENTS
 * ------------------------------------------------------------------------
 * Node.js 18+ (uses the global `fetch`). No npm dependencies -- built-ins
 * only, so this can be copied into the k6-demo repo standalone.
 */

const fs = require("node:fs");
const readline = require("node:readline");

const args = parseArgs(process.argv.slice(2));
const FILE = args.file || process.env.K6_JSON_OUT || "k6-stream.json";
const WINDOW_SECONDS = Number(process.env.WINDOW_SECONDS || args.window || 5);
const RUN_ID = process.env.RUN_ID;
const PROGRESS_URL = process.env.PORTAL_PROGRESS_URL;
const SECRET = process.env.PERFORMANCE_CALLBACK_SECRET;
const RAMP_UP_SECONDS = Number(process.env.RAMP_UP_SECONDS || 0);
const STEADY_SECONDS = Number(process.env.STEADY_SECONDS || 0);
const RAMP_DOWN_SECONDS = Number(process.env.RAMP_DOWN_SECONDS || 0);
const EXPECTED_TOTAL_SECONDS = RAMP_UP_SECONDS + STEADY_SECONDS + RAMP_DOWN_SECONDS || undefined;

// How long to wait with no new lines appended before assuming k6 is done
// and this process should exit on its own.
const IDLE_EXIT_MS = 15000;
// How often to check the file for new lines / flush a closed window.
const POLL_MS = 1000;

if (!RUN_ID || !PROGRESS_URL || !SECRET) {
  console.error(
    "[k6-progress-streamer] Missing required env vars (need RUN_ID, PORTAL_PROGRESS_URL, PERFORMANCE_CALLBACK_SECRET) -- exiting without streaming progress. The final results POST is unaffected.",
  );
  process.exit(0); // Non-fatal: never fail the Jenkins build over a missing streamer config.
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--file") out.file = argv[++i];
    if (argv[i] === "--window") out.window = argv[++i];
  }
  return out;
}

/** Sorted-array percentile (nearest-rank method) -- input must already be sorted ascending. */
function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, index)];
}

const testStartMs = Date.now();
let windowStartMs = Date.now();
let windowDurations = []; // http_req_duration values (ms) in the current window
let windowRequestCount = 0;
let windowFailedCount = 0;
let elapsedAtWindowsFlushed = 0;

function formatElapsed(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

async function flushWindow() {
  if (windowRequestCount === 0) {
    // No traffic in this window (e.g. between ramp phases) -- skip posting
    // an empty point rather than drawing a misleading zero on the chart.
    windowStartMs = Date.now();
    windowDurations = [];
    windowFailedCount = 0;
    return;
  }

  const sorted = [...windowDurations].sort((a, b) => a - b);
  elapsedAtWindowsFlushed += WINDOW_SECONDS;

  const point = {
    schemaVersion: 1,
    time: formatElapsed((Date.now() - testStartMs) / 1000),
    windowSeconds: WINDOW_SECONDS,
    requests: windowRequestCount,
    requestsPerSecond: Number((windowRequestCount / WINDOW_SECONDS).toFixed(2)),
    errorRate: Number((windowFailedCount / windowRequestCount).toFixed(4)),
    latencyMilliseconds: {
      p50: Math.round(percentile(sorted, 50)),
      p90: Math.round(percentile(sorted, 90)),
      p95: Math.round(percentile(sorted, 95)),
      p99: Math.round(percentile(sorted, 99)),
    },
  };
  if (EXPECTED_TOTAL_SECONDS) {
    point.progressPercent = Math.max(
      0,
      Math.min(100, Math.round((elapsedAtWindowsFlushed / EXPECTED_TOTAL_SECONDS) * 100)),
    );
  }

  windowStartMs = Date.now();
  windowDurations = [];
  windowRequestCount = 0;
  windowFailedCount = 0;

  try {
    const response = await fetch(`${PROGRESS_URL.replace(/\/$/, "")}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify(point),
    });
    if (!response.ok) {
      console.error(
        `[k6-progress-streamer] Portal rejected progress point (${response.status}): ${(await response.text()).slice(0, 300)}`,
      );
    }
  } catch (error) {
    // Never let a network hiccup crash the sidecar -- the next window's
    // point (or the final results POST) will still land.
    console.error("[k6-progress-streamer] Failed to POST progress point:", error.message);
  }
}

function handleLine(line) {
  if (!line.trim()) return;
  let sample;
  try {
    sample = JSON.parse(line);
  } catch {
    return; // Not a JSON line (k6 sometimes interleaves non-metric output) -- ignore.
  }
  if (sample.type !== "Point" || !sample.data) return;

  if (sample.metric === "http_reqs") {
    windowRequestCount += 1;
  } else if (sample.metric === "http_req_duration") {
    const value = Number(sample.data.value);
    if (Number.isFinite(value)) windowDurations.push(value);
  } else if (sample.metric === "http_req_failed") {
    if (Number(sample.data.value) === 1) windowFailedCount += 1;
  }
}

async function main() {
  console.log(`[k6-progress-streamer] Watching ${FILE} for run ${RUN_ID} (window=${WINDOW_SECONDS}s) -> ${PROGRESS_URL}`);

  let lastSize = 0;
  let lastActivityMs = Date.now();
  let readOffset = 0;

  const flushTimer = setInterval(() => {
    flushWindow().catch(() => {});
  }, WINDOW_SECONDS * 1000);

  const pollTimer = setInterval(async () => {
    try {
      const stats = fs.statSync(FILE);
      if (stats.size > lastSize) {
        lastActivityMs = Date.now();
        await readNewLines(stats.size);
        lastSize = stats.size;
      } else if (Date.now() - lastActivityMs > IDLE_EXIT_MS) {
        clearInterval(flushTimer);
        clearInterval(pollTimer);
        await flushWindow();
        console.log("[k6-progress-streamer] No new data for a while -- assuming k6 finished. Exiting.");
        process.exit(0);
      }
    } catch {
      // File doesn't exist yet (k6 hasn't started writing) -- keep polling.
    }
  }, POLL_MS);

  function readNewLines(upToSize) {
    return new Promise((resolve) => {
      const stream = fs.createReadStream(FILE, { start: readOffset, end: upToSize - 1 });
      const rl = readline.createInterface({ input: stream });
      rl.on("line", handleLine);
      rl.on("close", () => {
        readOffset = upToSize;
        resolve();
      });
    });
  }

  // Also flush on SIGTERM (Jenkins step being killed) so the last partial
  // window isn't silently dropped.
  process.on("SIGTERM", async () => {
    await flushWindow();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("[k6-progress-streamer] Fatal error:", error);
  process.exit(0); // Non-fatal: never fail the Jenkins build over the streamer itself.
});