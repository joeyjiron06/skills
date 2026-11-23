import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { JOBS_DIR, readState } from "./job.js";

const INDEX = join(import.meta.dirname, "index.html");
const PORT = Number(process.env.PORT) || 9101;
// Each job settles this long after its last file change before it's re-read
// and sent, so a burst of writes (e.g. the gate rewriting gate.md per command)
// becomes one event. Debounced per job, so one busy job never delays another.
const DEBOUNCE_MS = 150;
const HEARTBEAT_MS = 25_000;
const JOB_ID = /^\d{3}$/;
const ROUND = /^round-([1-9]\d*)$/;

// --- Job state ------------------------------------------------------------------
// A job is every markdown file in its folder, read as frontmatter. All values
// are strings, exactly as written (ROUND is "1", not 1). A step's file only
// exists once the step has started, so every step is optional.

/**
 * A file that exists but couldn't be parsed, e.g. read mid-write. The write
 * that finishes it sends the job again.
 * @typedef {{ ERROR: string }} FileError
 */

/**
 * Frontmatter of a step file, or a FileError if it couldn't be parsed.
 * @template T
 * @typedef {T | FileError} FileState
 */

/**
 * job.md, written by `job create`. Empty if job.md doesn't exist yet: the
 * folder is created a moment before the file.
 * @typedef {object} JobInfo
 * @property {string} ID         3-digit job id, e.g. "004"
 * @property {string} TITLE      one line; the pull request title
 * @property {string} STARTED    ISO timestamp
 * @property {string} BRANCH     e.g. "factory/004-add-dark-mode"
 * @property {string} WORKTREE   absolute path of the job's worktree
 * @property {string} [FINISHED] ISO timestamp, set by `job complete`
 */

/**
 * Fields every step file has. STATUS is RUNNING from `start` (or a feedback
 * reopen) until `complete`, which sets FINISHED and the step's OUTCOME.
 * @typedef {object} StepBase
 * @property {"RUNNING" | "COMPLETE"} STATUS
 * @property {string} STARTED    ISO timestamp
 * @property {string} [FINISHED] ISO timestamp, once COMPLETE
 */

/**
 * intake.md. FEEDBACK counts the author's replies to a BLOCKED intake; each
 * reply reopens it and clears the decision fields until it completes again.
 * SURFACES is a ", "-separated list of "ui" | "ux" | "security" | "none".
 * @typedef {StepBase & {
 *   OUTCOME?: "ACCEPT" | "BLOCKED" | "REJECT",
 *   RISK?: "low" | "medium" | "high",
 *   SURFACES?: string,
 *   RESCOPED?: "yes" | "no",
 *   FEEDBACK?: string,
 * }} IntakeState
 */

/**
 * spec.md.
 * @typedef {StepBase} SpecState
 */

/**
 * decision.md, the approver's decision on round ROUND. CHECKS is PASS when the
 * round passed its build, gate and reviews.
 * @typedef {StepBase & {
 *   ROUND: string,
 *   CHECKS: "PASS" | "FAIL",
 *   OUTCOME?: "APPROVE" | "APPROVAL-NEEDS-HUMAN" | "BLOCKED",
 * }} DecisionState
 */

/**
 * pr.md, the log of the pull request commands. OUTCOME is FAIL if one failed.
 * @typedef {StepBase & {
 *   DECISION: "APPROVE" | "APPROVAL-NEEDS-HUMAN",
 *   OUTCOME?: "PASS" | "FAIL",
 * }} PullRequestState
 */

/**
 * round-<N>/build.md. FEEDBACK counts the user's replies to a BLOCKED build.
 * @typedef {StepBase & {
 *   ROUND: string,
 *   OUTCOME?: "READY" | "BLOCKED",
 *   FEEDBACK?: string,
 * }} BuildState
 */

/**
 * round-<N>/gate.md, the log of the gate commands.
 * @typedef {StepBase & { ROUND: string, OUTCOME?: "PASS" | "FAIL" }} GateState
 */

/** @typedef {"code" | "security" | "ui" | "ux"} Reviewer */

/**
 * round-<N>/review-<reviewer>.md.
 * @typedef {StepBase & {
 *   REVIEWER: Reviewer,
 *   ROUND: string,
 *   OUTCOME?: "PASS" | "CHANGES",
 * }} ReviewState
 */

/**
 * The job folder's top-level <step>.md files, keyed by file name without .md.
 * Any other .md file there shows up under its own name.
 * @typedef {{
 *   intake?: FileState<IntakeState>,
 *   spec?: FileState<SpecState>,
 *   decision?: FileState<DecisionState>,
 *   pr?: FileState<PullRequestState>,
 *   [file: string]: FileState<Record<string, string>> | undefined,
 * }} JobSteps
 */

/**
 * A round-<N> folder. Only reviewers that have started are in `reviews`.
 * @typedef {object} Round
 * @property {number} round                          N, from the folder name
 * @property {FileState<BuildState>} [build]
 * @property {FileState<GateState>} [gate]
 * @property {Partial<Record<Reviewer, FileState<ReviewState>>>} reviews
 */

/**
 * A job as sent to clients.
 * @typedef {object} Job
 * @property {string} id                                   3-digit id, e.g. "004"
 * @property {FileState<JobInfo> | Record<string, never>} info
 * @property {JobSteps} steps
 * @property {Round[]} rounds                              sorted by round
 */

/** @returns {string[]} every job id, sorted */
function jobIds() {
  if (!existsSync(JOBS_DIR)) return [];
  return readdirSync(JOBS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && JOB_ID.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * @param {string} id
 * @returns {Job}
 */
function readJob(id) {
  const dir = join(JOBS_DIR, id);
  /** @type {Job} */
  const job = { id, info: safeState(join(dir, "job.md")), steps: {}, rounds: [] };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "job.md") {
      job.steps[entry.name.slice(0, -3)] = safeState(join(dir, entry.name));
    }
    const round = entry.isDirectory() && entry.name.match(ROUND)?.[1];
    if (round) job.rounds.push(readRound(join(dir, entry.name), Number(round)));
  }
  job.rounds.sort((a, b) => a.round - b.round);
  return job;
}

// build.md and gate.md become `build` and `gate`; review-<reviewer>.md goes
// under `reviews`.
/**
 * @param {string} dir   the round-<N> folder
 * @param {number} round N
 * @returns {Round}
 */
function readRound(dir, round) {
  /** @type {Round & Record<string, unknown>} */
  const state = { round, reviews: {} };
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const key = name.slice(0, -3);
    const reviewer = key.match(/^review-(.+)$/)?.[1];
    if (reviewer) state.reviews[/** @type {Reviewer} */ (reviewer)] = safeState(join(dir, name));
    else state[key] = safeState(join(dir, name));
  }
  return state;
}

/**
 * A file's frontmatter, {} if it doesn't exist, or a FileError. The caller
 * types it by the file it read.
 * @param {string} path
 * @returns {any}
 */
function safeState(path) {
  try {
    return readState(path);
  } catch (error) {
    return { ERROR: message(error) };
  }
}

/** @param {unknown} error */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

// --- Event stream -------------------------------------------------------------------
// GET /jobs streams:
//   event: jobs         data: [job, ...]   every job, once, when the client connects
//   event: job          data: job          a job was created or changed
//   event: job-removed  data: { id }       a job's folder was deleted

/**
 * The stream's events, by event name, with the type of their JSON `data`.
 * @typedef {object} JobEvents
 * @property {Job[]} jobs                    every job, once, on connect
 * @property {Job} job                       a job was created or changed
 * @property {{ id: string }} job-removed    a job's folder was deleted
 */

/** @type {Set<import("node:http").ServerResponse>} */
const clients = new Set();
// The last JSON sent per job, so writes that don't change any frontmatter
// (e.g. only a file body changed) aren't sent again.
/** @type {Map<string, string>} */
const sent = new Map();

/**
 * @template {keyof JobEvents} E
 * @param {import("node:http").ServerResponse} res
 * @param {E} event
 * @param {JobEvents[E]} data
 */
function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * @template {keyof JobEvents} E
 * @param {E} event
 * @param {JobEvents[E]} data
 */
function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
function openStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 2000\n\n");

  // Reading is synchronous, so no watcher event can land between the snapshot
  // and the client joining the broadcast list: nothing is missed.
  const jobs = [];
  for (const id of jobIds()) {
    try {
      const job = readJob(id);
      sent.set(id, JSON.stringify(job));
      jobs.push(job);
    } catch (error) {
      console.error(`failed to read job ${id}: ${message(error)}`);
    }
  }
  send(res, "jobs", jobs);
  clients.add(res);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

// --- Watcher ------------------------------------------------------------------------

/** @type {Map<string, NodeJS.Timeout>} */
const timers = new Map();

/** @param {string} id */
function schedule(id) {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    publish(id);
  }, DEBOUNCE_MS));
}

/** @param {string} id */
function publish(id) {
  if (!existsSync(join(JOBS_DIR, id))) {
    if (sent.delete(id)) broadcast("job-removed", { id });
    return;
  }
  if (!clients.size) return;
  let job;
  try {
    job = readJob(id);
  } catch (error) {
    console.error(`failed to read job ${id}: ${message(error)}`);
    return;
  }
  const json = JSON.stringify(job);
  if (sent.get(id) === json) return;
  sent.set(id, json);
  broadcast("job", job);
}

function watchJobs() {
  mkdirSync(JOBS_DIR, { recursive: true });
  const watcher = watch(JOBS_DIR, { recursive: true }, (_event, filename) => {
    // Some platforms omit the filename: re-check every job we know of.
    if (!filename) {
      for (const id of new Set([...jobIds(), ...sent.keys()])) schedule(id);
      return;
    }
    const id = filename.toString().split(sep)[0];
    if (JOB_ID.test(id)) schedule(id);
  });
  watcher.on("error", (error) => console.error(`jobs watcher error: ${error.message}`));
}

// --- HTTP ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end("Method Not Allowed");
    return;
  }
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/jobs") return openStream(req, res);
  if (pathname !== "/" && pathname !== "/index.html") {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
    return;
  }
  try {
    const html = await readFile(INDEX);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : html);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(`Error: ${message(error)}`);
  }
});

watchJobs();
server.listen(PORT, () => {
  console.log(`Factory server running at http://localhost:${PORT}`);
  console.log(`Watching ${JOBS_DIR}`);
});
