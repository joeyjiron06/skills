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
  job create --title "<title>" --prompt "<prompt>"      new job from a user prompt; prints the job id.
                                                        <title> is one line and becomes the pull request title
  job info --id <id>                                    gets info of the created job
  job intake start --id <id>                            starts the intake process by writing its status
  job intake complete --id <id> --content <file-path>   finishes the intake process with the final output from the agent
      --outcome <ACCEPT|NEEDS-INFO|REJECT> --risk <low|medium|high>
      --surfaces many_of<ui|ux|security|none> --rescoped <yes|no>
  job intake info --id <id>                             prints the frontmatter data from the intake.md file
  job spec-writer start --id <id>                       starts the spec writing process by writing its status
  job spec-writer complete --id <id> --content <file-path>
                                                        finishes spec writer step
  job spec-writer info --id <id>                        prints the frontmatter data from the spec.md file
  job builder start --id <id> --round <round>           starts the build process for a given round
  job builder complete --id <id> --round <round> --outcome <READY|BLOCKED> --content <file-path>
                                                        finishes build step
  job builder info --id <id> --round <round>            prints the frontmatter data from the build.md file
  job gate check --id <id> --round <round>              run the gated checks after the build to ensure things work properly
  job gate info --id <id> --round <round>               print the frontmatter data of round-<N>/gate.md
  job reviewer start --id <id> --round <round> --reviewer <reviewer>
                                                        starts the review process for a given reviewer
  job reviewer complete --id <id> --round <round> --reviewer <reviewer> --outcome <PASS|CHANGES> --content <file-path>
                                                        completes the reviewer stage
  job reviewer info --id <id> --round <round> --reviewer <reviewer|ALL>
                                                        prints the frontmatter of the reviewer, or of every needed reviewer for ALL
  job approver start --id <id>                          starts the approval of the latest round; needs its gate and every review to PASS
  job approver complete --id <id> --outcome <APPROVE|ESCALATE> --content <file-path>
                                                        opens the pull request, then records the decision in decision.md.
                                                        See "Pull requests" below
  job approver info --id <id>                           prints the frontmatter of decision.md
  job help                                              print this usage

  <id> is a job id: an incrementing 3-digit number (004).
  <reviewer> is one of: code | security | ui | ux

Pull requests:
  approver complete runs every command in config.json -> pull_request.<OUTCOME>
  (APPROVE or ESCALATE) in order, inside the job's worktree, and logs them to
  <job folder>/pr.md. It stops at the first command that fails, and leaves
  decision.md RUNNING so approver complete can run again once the cause is
  fixed. An empty list opens no pull request. Commands read these variables:

    $FACTORY_ID         the job id, e.g. 004
    $FACTORY_TITLE      the job's title, from job create --title
    $FACTORY_BRANCH     the job branch, e.g. factory/004
    $FACTORY_BASE       config.json -> base_branch, e.g. main
    $FACTORY_WORKTREE   the job's worktree folder
    $FACTORY_OUTCOME    APPROVE or ESCALATE
    $FACTORY_BODY_FILE  the approver's --content file: the pull request body
    $FACTORY_SCRIPTS    this script's folder, which holds ready-made pull request
                        scripts: github/pull-request.sh (the default) and
                        azure-devops/pull-request.sh

  Always quote them ("$FACTORY_TITLE"): the title comes from a user prompt.
`;

const JOBS_DIR = join(import.meta.dirname, "..", "jobs");
const REPO = join(import.meta.dirname, "..", "..", "..");
const CONFIG = join(import.meta.dirname, "..", "config.json");

// Every reviewer lens. `code` always reviews; the rest only when intake lists
// them in SURFACES.
const REVIEWERS = ["code", "security", "ui", "ux"];

// --- Commands -------------------------------------------------------------------
// The command is the positional words joined with a space; every value is a
// named, required option. Each option maps to a parser: (value, name) => parsed.

const id = parseJobId;
const round = parseRound;
const content = text;

const COMMANDS = {
  "help":                 { run: help },
  "create":               { options: { title: singleLine, prompt: text }, run: create },
  "info":                 { options: { id }, run: info },

  "intake start":         { options: { id }, run: intakeStart },
  "intake complete":      {
    options: {
      id, content,
      outcome: oneOf("ACCEPT", "NEEDS-INFO", "REJECT"),
      risk: oneOf("low", "medium", "high"),
      surfaces: manyOf("ui", "ux", "security", "none"),
      rescoped: oneOf("yes", "no"),
    },
    run: intakeComplete,
  },
  "intake info":          { options: { id }, run: intakeInfo },

  "spec-writer start":    { options: { id }, run: specWriterStart },
  "spec-writer complete": { options: { id, content }, run: specWriterComplete },
  "spec-writer info":     { options: { id }, run: specWriterInfo },

  "builder start":        { options: { id, round }, run: builderStart },
  "builder complete":     { options: { id, round, content, outcome: oneOf("READY", "BLOCKED") }, run: builderComplete },
  "builder info":         { options: { id, round }, run: builderInfo },

  "gate check":           { options: { id, round }, run: gateCheck },
  "gate info":            { options: { id, round }, run: gateInfo },

  "reviewer start":       { options: { id, round, reviewer: oneOf(...REVIEWERS) }, run: reviewerStart },
  "reviewer complete":    { options: { id, round, reviewer: oneOf(...REVIEWERS), content, outcome: oneOf("PASS", "CHANGES") }, run: reviewerComplete },
  "reviewer info":        { options: { id, round, reviewer: oneOf(...REVIEWERS, "ALL") }, run: reviewerInfo },

  "approver start":       { options: { id }, run: approverStart },
  "approver complete":    { options: { id, content, outcome: oneOf("APPROVE", "ESCALATE") }, run: approverComplete },
  "approver info":        { options: { id }, run: approverInfo },
};

process.on("uncaughtException", fail);

const OPTION_NAMES = new Set(Object.values(COMMANDS).flatMap(({ options = {} }) => Object.keys(options)));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries([...OPTION_NAMES].map((name) => [name, { type: "string" }])),
});

const name = positionals.join(" ");
if (!Object.hasOwn(COMMANDS, name)) fail(`unknown command: ${name || "(none)"}. Run "job help" for usage.`);
const { options = {}, run } = COMMANDS[name];
run(parseOptions(name, options, values));

// Rejects options the command doesn't take, then requires every option in
// `schema`. Each option's parser validates and converts its value.
function parseOptions(command, schema, values) {
  const extra = Object.keys(values).filter((option) => !Object.hasOwn(schema, option));
  if (extra.length) fail(`${command} doesn't take: ${extra.map((option) => `--${option}`).join(", ")}`);
  const missing = Object.keys(schema).filter((option) => !values[option]?.trim());
  if (missing.length) fail(`${command} is missing: ${missing.map((option) => `--${option}`).join(", ")}`);
  return Object.fromEntries(Object.entries(schema).map(([option, parse]) => [option, parse(values[option], option)]));
}

// --- Option parsers ---------------------------------------------------------------

function text(value) {
  return value;
}

// Trimmed text that fits on one line, like a title.
function singleLine(value, name) {
  const line = value.trim();
  if (/[\r\n]/.test(line)) fail(`bad --${name}: must be a single line`);
  return line;
}

function oneOf(...choices) {
  return (value, name) => {
    checkChoice(name, [value], choices);
    return value;
  };
}

// A comma-separated list where every item is one of `choices`.
function manyOf(...choices) {
  return (value, name) => {
    const items = splitList(value);
    checkChoice(name, items, choices, "comma-separated ");
    return items;
  };
}

// Validates a job id, failing if the job doesn't exist.
function parseJobId(id) {
  if (!/^\d{3}$/.test(id)) fail(`bad job id: ${id}. Expected a 3-digit id like 004.`);
  if (!existsSync(jobFile(id))) fail(`no such job: ${id}`);
  return id;
}

// Validates --round as a positive integer.
function parseRound(round) {
  if (!/^[1-9]\d*$/.test(round)) fail(`bad --round: ${round}. Expected a positive integer like 1.`);
  return Number(round);
}

// --- Run functions ----------------------------------------------------------------

function help() {
  console.log(USAGE);
}

function create({ title, prompt }) {
  const id = nextJobId();
  const branch = `factory/${id}`;
  const worktree = join(REPO, ".worktrees", id);

  mkdirSync(jobFile(id));
  // ID is quoted so YAML readers keep the leading zeros.
  const meta = frontmatter({ ID: `"${id}"`, TITLE: title, STARTED: now(), BRANCH: branch, WORKTREE: worktree });
  writeFileSync(jobFile(id, "job.md"), `${meta}\n## User Prompt\n\n${prompt.trim()}\n\n`);

  console.log(id);
}

function info({ id }) {
  printFrontmatter(jobFile(id, "job.md"));
}

function intakeStep(id) {
  return { name: "intake", id, path: jobFile(id, "intake.md") };
}

function intakeStart({ id }) {
  startStep(intakeStep(id));
}

function intakeComplete({ id, content, outcome, risk, surfaces, rescoped }) {
  if (surfaces.includes("none") && surfaces.length > 1) fail(`bad --surfaces: "none" can't be combined with other surfaces`);
  completeStep(intakeStep(id), content, { OUTCOME: outcome, RISK: risk, SURFACES: surfaces.join(", "), RESCOPED: rescoped });
}

function intakeInfo({ id }) {
  stepInfo(intakeStep(id));
}

function specWriterStep(id) {
  return { name: "spec-writer", id, path: jobFile(id, "spec.md") };
}

// The spec is only written for an intake that finished and was accepted.
function specWriterStart({ id }) {
  const intake = readState(jobFile(id, "intake.md"));
  if (intake.STATUS !== "COMPLETE" || intake.OUTCOME !== "ACCEPT") {
    fail(`spec-writer needs a complete, accepted intake for job ${id} (intake is ${describeState(intake)})`);
  }
  startStep(specWriterStep(id));
}

function specWriterComplete({ id, content }) {
  completeStep(specWriterStep(id), content);
}

function specWriterInfo({ id }) {
  stepInfo(specWriterStep(id));
}

function builderStep(id, round) {
  return {
    name: "builder",
    id,
    path: jobFile(id, `round-${round}`, "build.md"),
    flags: `--round ${round}`,
    fields: { ROUND: round },
  };
}

// Round 1 builds from a finished spec; later rounds follow a finished previous build.
function builderStart({ id, round }) {
  const [prevPath, prevLabel] = round === 1
    ? [jobFile(id, "spec.md"), "spec"]
    : [jobFile(id, `round-${round - 1}`, "build.md"), `round ${round - 1} build`];
  const prev = readState(prevPath);
  if (prev.STATUS !== "COMPLETE") {
    fail(`builder round ${round} needs a complete ${prevLabel} for job ${id} (${prevLabel} is ${describeState(prev)})`);
  }
  mkdirSync(jobFile(id, `round-${round}`), { recursive: true });
  startStep(builderStep(id, round));
}

function builderComplete({ id, round, content, outcome }) {
  completeStep(builderStep(id, round), content, { OUTCOME: outcome });
}

function builderInfo({ id, round }) {
  stepInfo(builderStep(id, round));
}

function gateStep(id, round) {
  return {
    name: "gate",
    id,
    path: jobFile(id, `round-${round}`, "gate.md"),
    flags: `--round ${round}`,
    fields: { ROUND: round },
  };
}

// The builder runs the gate while it works, so the build only needs to have started.
function gateCheck({ id, round }) {
  if (!existsSync(jobFile(id, `round-${round}`, "build.md"))) {
    fail(`gate needs build round ${round} started for job ${id}. Run "job builder start --id ${id} --round ${round}" first.`);
  }
  runGate(gateStep(id, round), jobWorktree(id));
}

function gateInfo({ id, round }) {
  stepInfo(gateStep(id, round));
}

// Fails unless `reviewer` is needed for the job. `needed` can be passed in to
// avoid re-reading intake.md.
function reviewerStep(id, round, reviewer, needed = neededReviewers(id)) {
  if (!needed.includes(reviewer)) fail(`reviewer ${reviewer} isn't needed for job ${id}. Needed: ${needed.join(", ")}`);
  return {
    name: "reviewer",
    id,
    path: jobFile(id, `round-${round}`, `review-${reviewer}.md`),
    flags: `--round ${round} --reviewer ${reviewer}`,
    fields: { REVIEWER: reviewer, ROUND: round },
  };
}

// Reviews only run on a build whose gate passed.
function reviewerStart({ id, round, reviewer }) {
  const step = reviewerStep(id, round, reviewer);
  const gate = readState(jobFile(id, `round-${round}`, "gate.md"));
  if (gate.STATUS !== "COMPLETE" || gate.OUTCOME !== "PASS") {
    fail(`reviewer needs a passing gate for job ${id} round ${round} (gate is ${describeState(gate)})`);
  }
  startStep(step);
}

function reviewerComplete({ id, round, reviewer, content, outcome }) {
  completeStep(reviewerStep(id, round, reviewer), content, { OUTCOME: outcome });
}

// For ALL, prints each needed reviewer's frontmatter under a `## <reviewer>`
// header; reviewers that haven't started show STATUS: NOT-STARTED.
function reviewerInfo({ id, round, reviewer }) {
  if (reviewer !== "ALL") return stepInfo(reviewerStep(id, round, reviewer));

  const needed = neededReviewers(id);
  const sections = needed.map((name) => {
    const { path } = reviewerStep(id, round, name, needed);
    const lines = existsSync(path) ? frontmatterLines(path) : [`REVIEWER: ${name}`, `ROUND: ${round}`, "STATUS: NOT-STARTED"];
    return [`## ${name}`, ...lines].join("\n");
  });
  console.log(sections.join("\n\n"));
}

// `code` plus every reviewer surface intake flagged, in REVIEWERS order.
function neededReviewers(id) {
  const intake = readState(jobFile(id, "intake.md"));
  if (intake.STATUS !== "COMPLETE") fail(`reviewer needs a complete intake for job ${id}`);
  const surfaces = splitList(intake.SURFACES ?? "");
  return REVIEWERS.filter((name) => name === "code" || surfaces.includes(name));
}

function approverStep(id) {
  return { name: "approver", id, path: jobFile(id, "decision.md") };
}

// The approver decides on the latest round, once its gate and every needed
// review passed. An ESCALATE from an earlier round is replaced: the user's
// feedback started a new round, which needs a new decision.
function approverStart({ id }) {
  const round = latestRound(id);
  if (!round) fail(`approver needs a build round for job ${id} (no rounds yet)`);

  const gate = readState(jobFile(id, `round-${round}`, "gate.md"));
  if (gate.STATUS !== "COMPLETE" || gate.OUTCOME !== "PASS") {
    fail(`approver needs a passing gate for job ${id} round ${round} (gate is ${describeState(gate)})`);
  }
  const notPassed = neededReviewers(id)
    .map((name) => [name, readState(jobFile(id, `round-${round}`, `review-${name}.md`))])
    .filter(([, review]) => review.STATUS !== "COMPLETE" || review.OUTCOME !== "PASS");
  if (notPassed.length) {
    const list = notPassed.map(([name, review]) => `${name} (${describeState(review)})`).join(", ");
    fail(`approver needs every review to pass for job ${id} round ${round}. Not passed: ${list}`);
  }

  const step = approverStep(id);
  const previous = readState(step.path);
  if (previous.STATUS === "COMPLETE" && previous.OUTCOME === "ESCALATE" && Number(previous.ROUND) < round) unlinkSync(step.path);
  startStep({ ...step, fields: { ROUND: round } });
}

// Opens the pull request before recording the decision, so a failed pull
// request leaves decision.md RUNNING and approver complete can run again.
function approverComplete({ id, content, outcome }) {
  const step = approverStep(id);
  const contentPath = checkCompletable(step, content);
  openPullRequest(id, outcome, contentPath);
  completeStep(step, content, { OUTCOME: outcome });
}

// Runs config.json -> pull_request.<decision> in the job's worktree, logging to pr.md.
function openPullRequest(id, decision, bodyFile) {
  const commands = pullRequestCommands(decision);
  if (!commands.length) return;

  const { TITLE: title, BRANCH: branch } = readFrontmatter(jobFile(id, "job.md"));
  if (!title) fail(`job ${id} has no TITLE in job.md, so its pull request has no title`);
  const worktree = jobWorktree(id);
  const env = {
    ...process.env,
    FACTORY_ID: id,
    FACTORY_TITLE: title,
    FACTORY_BRANCH: branch,
    FACTORY_BASE: baseBranch(),
    FACTORY_WORKTREE: worktree,
    FACTORY_OUTCOME: decision,
    FACTORY_BODY_FILE: bodyFile,
    FACTORY_SCRIPTS: import.meta.dirname,
  };
  const path = jobFile(id, "pr.md");
  const outcome = runCommands(path, { DECISION: decision }, commands, { cwd: worktree, env, stopOnFailure: true });
  if (outcome === "FAIL") {
    fail(`pull request failed for job ${id}, see ${path}. decision.md is still RUNNING: fix the cause and run approver complete again.`);
  }
}

function approverInfo({ id }) {
  stepInfo(approverStep(id));
}

// --- Jobs ---------------------------------------------------------------------------

function nextJobId() {
  mkdirSync(JOBS_DIR, { recursive: true });
  const ids = readdirSync(JOBS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{3}$/.test(entry.name))
    .map((entry) => Number(entry.name));
  const next = Math.max(0, ...ids) + 1;
  return String(next).padStart(3, "0");
}

// The highest N with a round-<N> folder, or 0 if there are none.
function latestRound(id) {
  const rounds = readdirSync(jobFile(id))
    .map((entry) => entry.match(/^round-([1-9]\d*)$/)?.[1])
    .filter(Boolean)
    .map(Number);
  return Math.max(0, ...rounds);
}

function jobFile(id, ...parts) {
  return join(JOBS_DIR, id, ...parts);
}

// The job's worktree folder from job.md, failing if it doesn't exist.
function jobWorktree(id) {
  const { WORKTREE: worktree } = readFrontmatter(jobFile(id, "job.md"));
  if (!worktree || !existsSync(worktree)) fail(`missing worktree for job ${id}: ${worktree ?? "(no WORKTREE in job.md)"}`);
  return worktree;
}

// --- Config -------------------------------------------------------------------------

function readConfig() {
  if (!existsSync(CONFIG)) fail(`missing config: ${CONFIG}`);
  return JSON.parse(readFileSync(CONFIG, "utf8"));
}

function isCommandList(list) {
  return Array.isArray(list) && list.every((c) => typeof c === "string" && c.trim());
}

// The config.json -> gate commands, failing unless it's a non-empty list of strings.
function gateCommands() {
  const { gate } = readConfig();
  if (!isCommandList(gate) || !gate.length) fail(`config.json -> gate must be a non-empty list of commands: ${CONFIG}`);
  return gate;
}

// The config.json -> pull_request.<decision> commands. An empty list is
// allowed: it opens no pull request.
function pullRequestCommands(decision) {
  const commands = readConfig().pull_request?.[decision];
  if (!isCommandList(commands)) fail(`config.json -> pull_request.${decision} must be a list of commands: ${CONFIG}`);
  return commands;
}

function baseBranch() {
  const { base_branch: base } = readConfig();
  if (typeof base !== "string" || !base.trim()) fail(`config.json -> base_branch must be a branch name: ${CONFIG}`);
  return base;
}

// --- Command runner -----------------------------------------------------------------

// Runs every config.json -> gate command in order inside the job's worktree.
// Re-running always starts gate.md over.
function runGate(step, worktree) {
  const outcome = runCommands(step.path, step.fields, gateCommands(), { cwd: worktree });
  console.log(`GATE: ${outcome}`);
  if (outcome === "FAIL") process.exit(1);
}

// Runs shell commands in order, rewriting the markdown file at `path` after each
// state change, then records and returns OUTCOME: PASS if every command exited
// 0, else FAIL. With stopOnFailure, the commands after a failure are SKIPPED.
function runCommands(path, fields, commands, { cwd, env, stopOnFailure = false }) {
  const meta = { ...fields, STATUS: "RUNNING", STARTED: now() };
  const results = commands.map((command) => ({ command, state: "PENDING" }));
  const write = () => writeFileSync(path, `${frontmatter(meta)}\n${results.map(commandSection).join("\n")}`);

  write();
  let failed = false;
  for (const result of results) {
    if (failed && stopOnFailure) {
      result.state = "SKIPPED";
      continue;
    }
    result.state = "RUNNING";
    write();
    Object.assign(result, runCommand(result.command, cwd, env));
    result.state = result.code === 0 ? "PASSED" : "FAILED";
    failed ||= result.code !== 0;
    write();
  }

  const outcome = failed ? "FAIL" : "PASS";
  Object.assign(meta, { STATUS: "COMPLETE", FINISHED: now(), OUTCOME: outcome });
  write();
  return outcome;
}

// Runs a shell command with stdout and stderr interleaved into one log, the
// way they'd appear in a terminal.
function runCommand(command, cwd, env = process.env) {
  const tmp = mkdtempSync(join(tmpdir(), "job-gate-"));
  const logPath = join(tmp, "log");
  const fd = openSync(logPath, "w");
  const started = Date.now();
  try {
    const { status, signal, error } = spawnSync("/bin/sh", ["-c", command], { cwd, env, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    let log = readFileSync(logPath, "utf8");
    if (error) log += `\n${error.message}`;
    if (signal) log += `\nkilled by ${signal}`;
    return { code: status ?? 1, seconds: (Date.now() - started) / 1000, log };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// One section per command: a header with the command and its state, and once
// it has finished, its logs in a collapsed <details>.
function commandSection({ command, state, code, seconds, log }) {
  const header = `## ${inlineCode(command)} — ${state}\n`;
  if (state === "PENDING" || state === "RUNNING" || state === "SKIPPED") return header;

  const fence = "`".repeat(Math.max(3, longestBacktickRun(log) + 1));
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
  const ticks = "`".repeat(longestBacktickRun(text) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function longestBacktickRun(text) {
  return (text.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
}

// --- Shared step lifecycle: start → complete → info ---------------------------
// A step is { name, id, path, flags?, fields? }: path is the step's markdown file,
// flags are extra CLI flags that identify it (e.g. "--round 2"), and fields are
// frontmatter written when it starts (e.g. { ROUND: 2 }).

// "job 004" or "job 004 (--round 2)", for messages.
function stepLabel({ id, flags }) {
  return flags ? `job ${id} (${flags})` : `job ${id}`;
}

// Run "job builder start --id 004 --round 2" first.
function notStarted(step) {
  const { name, id, flags } = step;
  fail(`${name} not started for ${stepLabel(step)}. Run "job ${name} start --id ${id}${flags ? ` ${flags}` : ""}" first.`);
}

// Writes a fresh RUNNING file. Restarting is allowed while still RUNNING.
function startStep(step) {
  const { name, path, fields = {} } = step;
  if (existsSync(path) && readFrontmatter(path).STATUS !== "RUNNING") {
    fail(`${name} already complete for ${stepLabel(step)}: ${path}`);
  }
  writeFileSync(path, frontmatter({ ...fields, STATUS: "RUNNING", STARTED: now() }));
  console.log(`${name} started for ${stepLabel(step)}`);
}

// Fails unless `step` is RUNNING and the content file exists; returns its
// absolute path.
function checkCompletable(step, content) {
  const { name, path } = step;
  if (!existsSync(path)) notStarted(step);
  if (readFrontmatter(path).STATUS !== "RUNNING") fail(`${name} already complete for ${stepLabel(step)}: ${path}`);
  const contentPath = resolve(content);
  if (!existsSync(contentPath)) fail(`missing content file: ${contentPath}`);
  return contentPath;
}

// Marks a RUNNING step COMPLETE, merges in `fields`, appends the content file
// below the frontmatter, then deletes the content file.
function completeStep(step, content, fields = {}) {
  const { name, path } = step;
  const contentPath = checkCompletable(step, content);
  const current = readFrontmatter(path);
  const body = readFileSync(contentPath, "utf8").trim();

  const md = frontmatter({
    ...current,
    STATUS: "COMPLETE",
    FINISHED: now(),
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

// A step file's frontmatter, or {} if the step hasn't started.
function readState(path) {
  return existsSync(path) ? readFrontmatter(path) : {};
}

// "not started", "RUNNING" or "COMPLETE, ACCEPT", for messages.
function describeState({ STATUS, OUTCOME }) {
  return [STATUS ?? "not started", OUTCOME].filter(Boolean).join(", ");
}

// "a, b,," -> ["a", "b"]
function splitList(text) {
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

function now() {
  return new Date().toISOString();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
