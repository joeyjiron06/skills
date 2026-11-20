import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const USAGE = `
Agents call this script, never write files directly to maintain the job process.

Usage:
  job create --prompt "<prompt>"                        new job from a user prompt; prints the job id
  job info <id>                                         gets info of the created job
  job intake <id> start                                 starts the intake process by writing it's status
  job intake <id> complete --content <file-path>        finishes the intake process with the final output from the agent
    --outcome <ACCEPT|NEEDS-INFO|REJECT>
    --risk: <low|medium|high>
    --surfaces: many_of<ui|ux|security|none>
    --rescoped: <yes|no>
  job intake <id> info                                  prints the frontmatter data from the intake.md file
  job spec-writer <id> start                            starts the spec writing process by writing it's status
  job spec-writer <id> complete --content <file-path>   finishes spec writer step
  job spec-writer <id> info                             prints the frontmatter data from the spec.md file
  job builder <id> start --round <round>                starts the build process for a given round
  job builder <id> complete --round <round>             finishes build step
    --content <file-path>
  job builder <id> info --round <round>                 prints the frontmatter data from the build.md file
  job gate <id> check --round <round>                   run the gated checks after the build to ensure things work properly
  job gate <id> info --round <round>                    print the frontmatter data of round-<N>/gate.md
  job reviewer <id> start                               starts the review process for a given reviewer
      --round <round>
      --reviewer <reviewer>
  job reviewer <id> complete --round <round>            completes the reviewer stage
      --reviewer <reviewer>
      --outcome <PASS|CHANGES>
      --content <file-path>
  job reviewer <id> info --round <round>                prints the contents of the reviewer or all the reviewers content if passed in ALL
      --reviewer <reviewer|ALL>
  job approver <id>                                     start starts the approval process
  job approver <id> complete                            completes the approval process
      --outcome <APPROVE|ESCALATE>
      --content <file-path>
  job approver <id> info                                prints the frontmatter of decision.md
  job complete <id>                                     completes the job
  job help                                              print this usage

  <id> is a job id: an incrementing 3-digit number (004).
`;

const JOBS_DIR = join(import.meta.dirname, "..", "jobs");
const REPO = join(import.meta.dirname, "../../../");
const CONFIG = join(import.meta.dirname, "..", "config.json");

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      prompt: { type: "string" },
      content: { type: "string" },
      outcome: { type: "string" },
      risk: { type: "string" },
      surfaces: { type: "string" },
      rescoped: { type: "string" },
      round: { type: "string" },
      reviewer: { type: "string" },
    },
  });
  const [command, ...args] = positionals;

  switch (command) {
    case "create":
      return create(values);
    case "info":
      return info(args);
    case "intake":
      return intake(args, values);
    case "spec-writer":
      return specWriter(args, values);
    case "builder":
      return builder(args, values);
    case "gate":
      return gate(args, values);
    case "reviewer":
      return reviewer(args, values);
    case "help":
      return help();
    default:
      fail(`unknown command: ${command ?? "(none)"}. Run "job help" for usage.`);
  }
}

function create({ prompt }) {
  if (!prompt?.trim()) fail('create needs --prompt "<prompt>"');

  const id = nextJobId();
  const dir = join(JOBS_DIR, id);
  const branch = `factory/${id}`;
  const worktree = join(REPO, ".worktrees", id);

  mkdirSync(dir, { recursive: true });

  const md =`---
ID: "${id}"
STARTED: ${new Date().toISOString()}
BRANCH: ${branch}
WORKTREE: ${worktree}
---

## User Prompt

${prompt.trim()}

`;
  writeFileSync(join(dir, "job.md"), md);

  console.log(id);
}

function info([id]) {
  printFrontmatter(join(jobDir(id), "job.md"));
}

// Validates a job id and returns its folder, failing if the job doesn't exist.
function jobDir(id) {
  if (!id) fail('missing job id. Usage: job <command> <id> (e.g. "job info 004")');
  if (!/^\d{3}$/.test(id)) fail(`bad job id: ${id}. Expected a 3-digit id like 004.`);
  const dir = join(JOBS_DIR, id);
  if (!existsSync(dir)) fail(`no such job: ${id}`);
  return dir;
}

function intake([id, action], values) {
  const step = { name: "intake", id, path: join(jobDir(id), "intake.md") };

  switch (action) {
    case "start":
      return startStep(step);
    case "complete": {
      requireFlags(step, values, ["content", ...Object.keys(INTAKE_OPTIONS)]);
      const surfaces = values.surfaces.split(",").map((s) => s.trim()).filter(Boolean);
      checkChoice("outcome", [values.outcome], INTAKE_OPTIONS.outcome);
      checkChoice("risk", [values.risk], INTAKE_OPTIONS.risk);
      checkChoice("surfaces", surfaces, INTAKE_OPTIONS.surfaces, "comma-separated ");
      checkChoice("rescoped", [values.rescoped], INTAKE_OPTIONS.rescoped);
      if (surfaces.includes("none") && surfaces.length > 1) fail(`bad --surfaces: "none" can't be combined with other surfaces`);

      return completeStep(step, values.content, {
        OUTCOME: values.outcome,
        RISK: values.risk,
        SURFACES: surfaces.join(", "),
        RESCOPED: values.rescoped,
      });
    }
    case "info":
      return stepInfo(step);
    default:
      fail(`unknown intake action: ${action ?? "(none)"}. Run "job help" for usage.`);
  }
}

const INTAKE_OPTIONS = {
  outcome: ["ACCEPT", "NEEDS-INFO", "REJECT"],
  risk: ["low", "medium", "high"],
  surfaces: ["ui", "ux", "security", "none"],
  rescoped: ["yes", "no"],
};

function specWriter([id, action], values) {
  const dir = jobDir(id);
  const step = { name: "spec-writer", id, path: join(dir, "spec.md") };

  switch (action) {
    case "start": {
      // The spec is only written for an intake that finished and was accepted.
      const intakePath = join(dir, "intake.md");
      const intake = existsSync(intakePath) ? readFrontmatter(intakePath) : {};
      if (intake.STATUS !== "COMPLETE" || intake.OUTCOME !== "ACCEPT") {
        fail(`spec-writer needs a complete, accepted intake for job ${id} (intake is ${intake.STATUS ?? "not started"}${intake.OUTCOME ? `, ${intake.OUTCOME}` : ""})`);
      }
      return startStep(step);
    }
    case "complete":
      requireFlags(step, values, ["content"]);
      return completeStep(step, values.content);
    case "info":
      return stepInfo(step);
    default:
      fail(`unknown spec-writer action: ${action ?? "(none)"}. Run "job help" for usage.`);
  }
}

function builder([id, action], values) {
  const dir = jobDir(id);
  const round = parseRound(values.round);
  const roundDir = join(dir, `round-${round}`);
  const step = {
    name: "builder",
    id,
    path: join(roundDir, "build.md"),
    flags: `--round ${round}`,
    fields: { ROUND: round },
  };

  switch (action) {
    case "start": {
      // Round 1 builds from a finished spec; later rounds follow a finished previous build.
      const [prevPath, prevLabel] = round === 1
        ? [join(dir, "spec.md"), "spec"]
        : [join(dir, `round-${round - 1}`, "build.md"), `round ${round - 1} build`];
      const prev = existsSync(prevPath) ? readFrontmatter(prevPath) : {};
      if (prev.STATUS !== "COMPLETE") {
        fail(`builder round ${round} needs a complete ${prevLabel} for job ${id} (${prevLabel} is ${prev.STATUS ?? "not started"})`);
      }
      mkdirSync(roundDir, { recursive: true });
      return startStep(step);
    }
    case "complete":
      requireFlags(step, values, ["content"]);
      return completeStep(step, values.content);
    case "info":
      return stepInfo(step);
    default:
      fail(`unknown builder action: ${action ?? "(none)"}. Run "job help" for usage.`);
  }
}

function gate([id, action], values) {
  const dir = jobDir(id);
  const round = parseRound(values.round);
  const step = {
    name: "gate",
    id,
    path: join(dir, `round-${round}`, "gate.md"),
    flags: `--round ${round}`,
  };

  switch (action) {
    case "check":
      return gateCheck(step, dir, round);
    case "info":
      return stepInfo(step);
    default:
      fail(`unknown gate action: ${action ?? "(none)"}. Run "job help" for usage.`);
  }
}

// Runs every config.json -> gate command in order inside the job's worktree,
// rewriting gate.md after each state change, then records OUTCOME: PASS | FAIL.
// Re-running always starts gate.md over: the builder runs it while it works.
function gateCheck(step, dir, round) {
  const build = join(dir, `round-${round}`, "build.md");
  if (!existsSync(build)) {
    fail(`gate needs build round ${round} started for job ${step.id}. Run "job builder ${step.id} start --round ${round}" first.`);
  }

  const { WORKTREE: worktree } = readFrontmatter(join(dir, "job.md"));
  if (!worktree || !existsSync(worktree)) fail(`missing worktree for job ${step.id}: ${worktree ?? "(no WORKTREE in job.md)"}`);

  const commands = gateCommands();
  const meta = { ROUND: round, STATUS: "RUNNING", STARTED: new Date().toISOString() };
  const results = commands.map((command) => ({ command, state: "PENDING" }));
  const write = () => writeFileSync(step.path, `${frontmatter(meta)}\n${results.map(gateSection).join("\n")}`);

  write();
  for (const result of results) {
    result.state = "RUNNING";
    write();
    Object.assign(result, runCommand(result.command, worktree));
    result.state = result.code === 0 ? "PASSED" : "FAILED";
    write();
  }

  const outcome = results.every((result) => result.state === "PASSED") ? "PASS" : "FAIL";
  Object.assign(meta, { STATUS: "COMPLETE", FINISHED: new Date().toISOString(), OUTCOME: outcome });
  write();

  console.log(`GATE: ${outcome}`);
  if (outcome === "FAIL") process.exit(1);
}

// The config.json -> gate commands, failing unless it's a non-empty list of strings.
function gateCommands() {
  if (!existsSync(CONFIG)) fail(`missing config: ${CONFIG}`);
  const { gate } = JSON.parse(readFileSync(CONFIG, "utf8"));
  const valid = Array.isArray(gate) && gate.length && gate.every((c) => typeof c === "string" && c.trim());
  if (!valid) fail(`config.json -> gate must be a non-empty list of commands: ${CONFIG}`);
  return gate;
}

// Runs a shell command with stdout and stderr interleaved into one log, the
// way they'd appear in a terminal.
function runCommand(command, cwd) {
  const tmp = mkdtempSync(join(tmpdir(), "job-gate-"));
  const logPath = join(tmp, "log");
  const fd = openSync(logPath, "w");
  const started = Date.now();
  try {
    const { status, signal, error } = spawnSync("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    let log = readFileSync(logPath, "utf8");
    if (error) log += `\n${error.message}`;
    if (signal) log += `\nkilled by ${signal}`;
    return { code: status ?? 1, seconds: (Date.now() - started) / 1000, log };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// One gate.md section: a header with the command and its state, and once it
// has finished, its logs in a collapsed <details>.
function gateSection({ command, state, code, seconds, log }) {
  const header = `## ${inlineCode(command)} — ${state}\n`;
  if (state === "PENDING" || state === "RUNNING") return header;

  const fence = "`".repeat(Math.max(3, longestRun(log, "`") + 1));
  const body = log.trimEnd() || "(no output)";
  return `${header}
<details>
<summary>Logs (exit ${code}, ${seconds.toFixed(1)}s)</summary>

${fence}
${body}
${fence}

</details>
`;
}

// Wraps text in enough backticks that backticks inside it can't close the span.
function inlineCode(text) {
  const ticks = "`".repeat(longestRun(text, "`") + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function longestRun(text, char) {
  let longest = 0;
  let run = 0;
  for (const c of text) {
    run = c === char ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

// Every reviewer lens. `code` always reviews; the rest only when intake lists
// them in SURFACES.
const REVIEWERS = ["code", "security", "ui", "ux"];

function reviewer([id, action], values) {
  const dir = jobDir(id);
  const round = parseRound(values.round);
  const roundDir = join(dir, `round-${round}`);
  const needed = neededReviewers(dir, id);

  if (action === "info" && values.reviewer === "ALL") return reviewersInfo(id, roundDir, round, needed);

  const name = values.reviewer;
  if (!name) fail(`missing --reviewer <${REVIEWERS.join("|")}${action === "info" ? "|ALL" : ""}>`);
  checkChoice("reviewer", [name], REVIEWERS);
  if (!needed.includes(name)) fail(`reviewer ${name} isn't needed for job ${id}. Needed: ${needed.join(", ")}`);
  const step = reviewerStep(id, roundDir, round, name);

  switch (action) {
    case "start": {
      // Reviews only run on a build whose gate passed.
      const gatePath = join(roundDir, "gate.md");
      const gate = existsSync(gatePath) ? readFrontmatter(gatePath) : {};
      if (gate.STATUS !== "COMPLETE" || gate.OUTCOME !== "PASS") {
        fail(`reviewer needs a passing gate for job ${id} round ${round} (gate is ${gate.STATUS ?? "not started"}${gate.OUTCOME ? `, ${gate.OUTCOME}` : ""})`);
      }
      return startStep(step);
    }
    case "complete":
      requireFlags(step, values, ["content", "outcome"]);
      checkChoice("outcome", [values.outcome], ["PASS", "CHANGES"]);
      return completeStep(step, values.content, { OUTCOME: values.outcome });
    case "info":
      return stepInfo(step);
    default:
      fail(`unknown reviewer action: ${action ?? "(none)"}. Run "job help" for usage.`);
  }
}

function reviewerStep(id, roundDir, round, name) {
  return {
    name: "reviewer",
    id,
    path: join(roundDir, `review-${name}.md`),
    flags: `--round ${round} --reviewer ${name}`,
    fields: { REVIEWER: name, ROUND: round },
  };
}

// `code` plus every reviewer surface intake flagged, in REVIEWERS order.
function neededReviewers(dir, id) {
  const intakePath = join(dir, "intake.md");
  const intake = existsSync(intakePath) ? readFrontmatter(intakePath) : {};
  if (intake.STATUS !== "COMPLETE") fail(`reviewer needs a complete intake for job ${id}`);
  const surfaces = (intake.SURFACES ?? "").split(",").map((s) => s.trim());
  return REVIEWERS.filter((name) => name === "code" || surfaces.includes(name));
}

// Prints each needed reviewer's frontmatter under a `## <reviewer>` header;
// reviewers that haven't started show STATUS: NOT-STARTED.
function reviewersInfo(id, roundDir, round, needed) {
  const sections = needed.map((name) => {
    const { path } = reviewerStep(id, roundDir, round, name);
    const lines = existsSync(path) ? frontmatterLines(path) : [`REVIEWER: ${name}`, `ROUND: ${round}`, "STATUS: NOT-STARTED"];
    return [`## ${name}`, ...lines].join("\n");
  });
  console.log(sections.join("\n\n"));
}

// Validates --round as a positive integer.
function parseRound(round) {
  if (!round) fail("missing --round <round>");
  if (!/^[1-9]\d*$/.test(round)) fail(`bad --round: ${round}. Expected a positive integer like 1.`);
  return Number(round);
}

// --- Shared step lifecycle: start → complete → info ---------------------------
// A step is { name, id, path, flags?, fields? }: path is the step's markdown file,
// flags are extra CLI flags that identify it (e.g. "--round 2"), and fields are
// frontmatter written when it starts (e.g. { ROUND: 2 }).

// "job 004" or "job 004 (--round 2)", for messages.
function stepLabel({ id, flags }) {
  return flags ? `job ${id} (${flags})` : `job ${id}`;
}

function notStarted(step) {
  const { name, id, flags } = step;
  fail(`${name} not started for ${stepLabel(step)}. Run "job ${name} ${id} start${flags ? ` ${flags}` : ""}" first.`);
}

// Writes a fresh RUNNING file. Restarting is allowed while still RUNNING.
function startStep(step) {
  const { name, path, fields = {} } = step;
  if (existsSync(path) && readFrontmatter(path).STATUS !== "RUNNING") {
    fail(`${name} already complete for ${stepLabel(step)}: ${path}`);
  }
  writeFileSync(path, frontmatter({ ...fields, STATUS: "RUNNING", STARTED: new Date().toISOString() }));
  console.log(`${name} started for ${stepLabel(step)}`);
}

// Marks a RUNNING step COMPLETE, merges in `fields`, appends the content file
// below the frontmatter, then deletes the content file.
function completeStep(step, content, fields = {}) {
  const { name, path } = step;
  if (!existsSync(path)) notStarted(step);
  const current = readFrontmatter(path);
  if (current.STATUS !== "RUNNING") fail(`${name} already complete for ${stepLabel(step)}: ${path}`);

  const contentPath = resolve(content);
  if (!existsSync(contentPath)) fail(`missing content file: ${contentPath}`);
  const body = readFileSync(contentPath, "utf8").trim();

  const md = frontmatter({
    ...current,
    STATUS: "COMPLETE",
    FINISHED: new Date().toISOString(),
    ...fields,
  });
  writeFileSync(path, `${md}\n${body}\n`);
  unlinkSync(contentPath);

  console.log(`${name} complete for ${stepLabel(step)}${fields.OUTCOME ? `: ${fields.OUTCOME}` : ""}`);
}

function stepInfo(step) {
  if (!existsSync(step.path)) notStarted(step);
  printFrontmatter(step.path);
}

// Fails listing every flag in `keys` that wasn't passed.
function requireFlags({ name }, values, keys) {
  const missing = keys.filter((key) => !values[key]?.trim());
  if (missing.length) fail(`${name} complete is missing: ${missing.map((key) => `--${key}`).join(", ")}`);
}

// Fails if any of `given` isn't in `allowed`.
function checkChoice(key, given, allowed, hint = "") {
  const bad = given.filter((value) => !allowed.includes(value));
  if (bad.length) fail(`bad --${key}: ${bad.join(", ")}. Expected ${hint}one of: ${allowed.join(" | ")}`);
}

// Serializes a flat object into a `---` frontmatter block.
function frontmatter(data) {
  const lines = Object.entries(data).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

function printFrontmatter(path) {
  console.log(frontmatterLines(path).join("\n"));
}

// The trimmed, non-empty lines between a file's leading `---` lines.
function frontmatterLines(path) {
  if (!existsSync(path)) fail(`missing file: ${path}`);

  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (lines[0] !== "---") fail(`no frontmatter in ${path}`);
  const end = lines.indexOf("---", 1);
  if (end === -1) fail(`unclosed frontmatter in ${path}`);

  return lines.slice(1, end).filter(Boolean);
}

// Parses flat `KEY: value` frontmatter into an object. Values stay strings.
function readFrontmatter(path) {
  const data = {};
  for (const line of frontmatterLines(path)) {
    if (line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) fail(`bad frontmatter line in ${path}: ${line}`);
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    data[key] = value;
  }
  return data;
}

function help() {
  console.log(USAGE);
}

function nextJobId() {
  mkdirSync(JOBS_DIR, { recursive: true });
  const ids = readdirSync(JOBS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{3}$/.test(entry.name))
    .map((entry) => Number(entry.name));
  const next = Math.max(0, ...ids) + 1;
  return String(next).padStart(3, "0");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main().catch(error => fail(error));
