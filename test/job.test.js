// Tests for skills/factory/scripts/job.js, the factory's job state machine.
//
// Run from the repo root (no dependencies, Node >= 22):
//
//   node --test --experimental-test-coverage \
//     --test-coverage-lines=100 --test-coverage-branches=100 --test-coverage-functions=100
//
// job.js resolves its jobs/ folder, config.json and the repo root from its own
// location, so the tests never run it in place (that would write into the real
// skill). Instead they build a throwaway factory under test/.sandbox/ whose
// scripts/job.js is a symlink to the real file, and run it with
// --preserve-symlinks-main so import.meta.dirname points into the sandbox:
//
//   test/.sandbox/                         <repo>
//   test/.sandbox/.worktrees/<id>/          <worktree> for a job
//   test/.sandbox/skills/factory/config.json
//   test/.sandbox/skills/factory/jobs/      <jobs>
//   test/.sandbox/skills/factory/scripts/job.js -> skills/factory/scripts/job.js
//
// Every test spawns the script as a child process, exactly the way agents call
// it (`node <scripts>/job.js ...`). Node's coverage collects from the children
// too, so the report covers job.js (listed under its sandbox path).

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const REAL_FACTORY = join(ROOT, "skills", "factory");
const SANDBOX = join(import.meta.dirname, ".sandbox");
const FACTORY = join(SANDBOX, "skills", "factory");
const SCRIPT = join(FACTORY, "scripts", "job.js");
const CONFIG = join(FACTORY, "config.json");
const JOBS = join(FACTORY, "jobs");
const WORKTREES = join(SANDBOX, ".worktrees");
const SCRATCH = join(SANDBOX, "scratch");

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// --- Harness ------------------------------------------------------------------

before(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(join(FACTORY, "scripts"), { recursive: true });
  symlinkSync(join(REAL_FACTORY, "scripts", "job.js"), SCRIPT);
});

beforeEach(() => {
  for (const dir of [JOBS, WORKTREES, SCRATCH]) rmSync(dir, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  copyFileSync(join(REAL_FACTORY, "config.json"), CONFIG);
});

// test/.sandbox/ is left in place (git-ignored): the coverage report reads job.js
// through it after the tests finish. It is wiped at the start of every run.

// Runs `node job.js ...args` from the repo root.
function job(...args) {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    ["--preserve-symlinks-main", SCRIPT, ...args],
    { cwd: SANDBOX, encoding: "utf8" },
  );
  return { code: status, stdout, stderr };
}

// Runs a command that must succeed; returns its stdout.
function ok(...args) {
  const result = job(...args);
  assert.equal(result.code, 0, `expected success, got stderr: ${result.stderr}`);
  assert.equal(result.stderr, "");
  return result.stdout;
}

// Runs a command that must fail; returns its trimmed stderr.
function err(...args) {
  const result = job(...args);
  assert.equal(result.code, 1, `expected failure, got stdout: ${result.stdout}`);
  assert.equal(result.stdout, "");
  return result.stderr.trim();
}

// Writes an agent's temporary content file and returns its absolute path.
let contentCount = 0;
function contentFile(text = "## Summary\n\n- did the thing\n") {
  const path = join(SCRATCH, `content-${++contentCount}.md`);
  writeFileSync(path, text);
  return path;
}

const jobPath = (id, ...parts) => join(JOBS, id, ...parts);
const read = (id, ...parts) => readFileSync(jobPath(id, ...parts), "utf8");
const write = (id, file, text) => writeFileSync(jobPath(id, file), text);

// Parses the frontmatter of a markdown string into { KEY: "value" }.
function fm(text) {
  const lines = text.split("\n");
  assert.equal(lines[0], "---");
  const end = lines.indexOf("---", 1);
  return Object.fromEntries(lines.slice(1, end).map((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon), line.slice(colon + 2)];
  }));
}

// The markdown below a file's frontmatter.
function body(text) {
  const end = text.indexOf("\n---\n", 3);
  return text.slice(end + 5);
}

// Writes a config with the given gate. Pull requests are off unless a test
// passes its own `pull_request`, so no test ever runs git push or gh.
function setGate(gate, { pull_request = { APPROVE: [], ESCALATE: [] }, base_branch = "main" } = {}) {
  writeFileSync(CONFIG, JSON.stringify({ base_branch, gate, pull_request }));
}

// --- Pipeline shortcuts ---------------------------------------------------------

function createJob(prompt = "Add a dark mode toggle", title = "Add a dark mode toggle") {
  return ok("create", "--title", title, "--prompt", prompt).trim();
}

function finishIntake(id, { outcome = "ACCEPT", risk = "low", surfaces = "none", rescoped = "no" } = {}) {
  ok("intake", "start", "--id", id);
  ok("intake", "complete", "--id", id, "--content", contentFile(), "--outcome", outcome,
    "--risk", risk, "--surfaces", surfaces, "--rescoped", rescoped);
}

function finishSpec(id) {
  ok("spec-writer", "start", "--id", id);
  ok("spec-writer", "complete", "--id", id, "--content", contentFile("# Spec\n"));
}

function finishBuild(id, round = 1) {
  ok("builder", "start", "--id", id, "--round", String(round));
  ok("builder", "complete", "--id", id, "--round", String(round), "--outcome", "READY",
    "--content", contentFile("# Build\n"));
}

function makeWorktree(id) {
  const dir = join(WORKTREES, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function passGate(id, round = 1) {
  makeWorktree(id);
  setGate(["true"]);
  ok("gate", "check", "--id", id, "--round", String(round));
}

// A job whose round-1 build passed the gate, ready for reviewers.
function readyForReview(intake = {}) {
  const id = createJob();
  finishIntake(id, intake);
  finishSpec(id);
  finishBuild(id);
  passGate(id);
  return id;
}

// Every needed reviewer passes the given round.
function passReviews(id, round = 1) {
  const names = ok("reviewer", "info", "--id", id, "--round", String(round), "--reviewer", "ALL").match(/^## (\w+)$/gm)
    .map((header) => header.slice(3));
  for (const name of names) {
    ok("reviewer", "start", "--id", id, "--round", String(round), "--reviewer", name);
    ok("reviewer", "complete", "--id", id, "--round", String(round), "--reviewer", name,
      "--outcome", "PASS", "--content", contentFile());
  }
}

function finishApprover(id, outcome = "APPROVE") {
  ok("approver", "start", "--id", id);
  ok("approver", "complete", "--id", id, "--outcome", outcome, "--content", contentFile("## Summary\n"));
}

// --- Commands -------------------------------------------------------------------

describe("command dispatch", () => {
  test("help prints the usage", () => {
    const out = ok("help");
    assert.match(out, /Agents call this script, never write files directly/);
    assert.match(out, /job create --title "<title>" --prompt "<prompt>"/);
    for (const name of ["ID", "TITLE", "BRANCH", "BASE", "WORKTREE", "OUTCOME", "BODY_FILE", "SCRIPTS"]) {
      assert.match(out, new RegExp(`\\$FACTORY_${name} `));
    }
    assert.match(out, /job gate check --id <id> --round <round>/);
    assert.match(out, /job approver complete --id <id> --outcome <APPROVE\|ESCALATE> --content <file-path>/);
  });

  test("no command fails with (none)", () => {
    assert.equal(err(), 'unknown command: (none). Run "job help" for usage.');
  });

  test("an unknown command fails", () => {
    assert.equal(err("deploy"), 'unknown command: deploy. Run "job help" for usage.');
  });

  test("an unknown action fails as an unknown command", () => {
    assert.equal(err("intake", "finish"), 'unknown command: intake finish. Run "job help" for usage.');
  });

  test("a command rejects options it doesn't take", () => {
    const id = createJob();
    assert.equal(err("intake", "start", "--id", id, "--round", "1"), "intake start doesn't take: --round");
    assert.equal(err("help", "--id", "001"), "help doesn't take: --id");
    assert.ok(!existsSync(jobPath(id, "intake.md")));
  });

  test("unknown flags are rejected by the argument parser", () => {
    assert.match(err("help", "--bogus"), /Unknown option '--bogus'/);
  });

  test("the `--risk:` spelling from the usage/intake docs is rejected", () => {
    const id = createJob();
    ok("intake", "start", "--id", id);
    assert.match(err("intake", "complete", "--id", id, "--risk:", "low"), /Unknown option '--risk:'/);
  });
});

describe("create", () => {
  test("creates job 001 with job.md and prints the id", () => {
    const before = Date.now();
    assert.equal(ok("create", "--title", "  Add dark mode  ", "--prompt", "  Add a dark mode toggle\n\n"), "001\n");

    const text = read("001", "job.md");
    const meta = fm(text);
    assert.equal(meta.ID, '"001"');
    assert.equal(meta.TITLE, "Add dark mode");
    assert.match(meta.STARTED, ISO);
    assert.ok(Date.parse(meta.STARTED) >= before - 1000);
    assert.equal(meta.BRANCH, "factory/001");
    assert.equal(meta.WORKTREE, join(SANDBOX, ".worktrees", "001"));
    assert.equal(body(text), "\n## User Prompt\n\nAdd a dark mode toggle\n\n");
  });

  test("ids increment as 3-digit numbers", () => {
    assert.equal(createJob("one"), "001");
    assert.equal(createJob("two"), "002");
    assert.equal(createJob("three"), "003");
    assert.ok(existsSync(jobPath("003", "job.md")));
  });

  test("the next id ignores files and folders that aren't 3-digit job ids", () => {
    mkdirSync(jobPath("009"), { recursive: true });
    mkdirSync(jobPath("abc"));
    mkdirSync(jobPath("1234"));
    writeFileSync(jobPath("500"), "a file, not a job");
    assert.equal(createJob(), "010");
  });

  test("needs --title and --prompt", () => {
    assert.equal(err("create"), "create is missing: --title, --prompt");
    assert.equal(err("create", "--title", "t"), "create is missing: --prompt");
    assert.equal(err("create", "--prompt", "p"), "create is missing: --title");
    assert.ok(!existsSync(JOBS));
  });

  test("rejects a blank prompt or title", () => {
    assert.equal(err("create", "--title", "t", "--prompt", "   "), "create is missing: --prompt");
    assert.equal(err("create", "--title", "  ", "--prompt", "p"), "create is missing: --title");
  });

  test("rejects a title on more than one line", () => {
    assert.equal(err("create", "--title", "one\ntwo", "--prompt", "p"), "bad --title: must be a single line");
    assert.equal(err("create", "--title", "one\rtwo", "--prompt", "p"), "bad --title: must be a single line");
    assert.ok(!existsSync(JOBS));
  });
});

describe("job ids", () => {
  test("info prints the job.md frontmatter", () => {
    const id = createJob();
    const out = ok("info", "--id", id).trimEnd().split("\n");
    assert.equal(out.length, 5);
    assert.equal(out[0], 'ID: "001"');
    assert.equal(out[1], "TITLE: Add a dark mode toggle");
    assert.match(out[2], /^STARTED: /);
    assert.equal(out[3], "BRANCH: factory/001");
    assert.equal(out[4], `WORKTREE: ${join(SANDBOX, ".worktrees", "001")}`);
  });

  test("a missing id fails", () => {
    assert.equal(err("info"), "info is missing: --id");
  });

  test("an id that isn't 3 digits fails", () => {
    for (const id of ["4", "0004", "abc", "../001"]) {
      assert.equal(err("info", "--id", id), `bad job id: ${id}. Expected a 3-digit id like 004.`);
    }
  });

  test("an id with no job folder fails", () => {
    assert.equal(err("info", "--id", "042"), "no such job: 042");
  });

  test("every per-job command validates the id", () => {
    const commands = [
      ["intake", "info"],
      ["spec-writer", "info"],
      ["builder", "info", "--round", "1"],
      ["gate", "info", "--round", "1"],
      ["reviewer", "info", "--round", "1", "--reviewer", "ALL"],
    ];
    for (const [command, action, ...rest] of commands) {
      assert.equal(err(command, action, "--id", "042", ...rest), "no such job: 042");
    }
  });
});

describe("intake", () => {
  test("start writes a RUNNING intake.md", () => {
    const id = createJob();
    assert.equal(ok("intake", "start", "--id", id), "intake started for job 001\n");
    const meta = fm(read(id, "intake.md"));
    assert.deepEqual(Object.keys(meta), ["STATUS", "STARTED"]);
    assert.equal(meta.STATUS, "RUNNING");
    assert.match(meta.STARTED, ISO);
  });

  test("start can be re-run while RUNNING, but not once COMPLETE", () => {
    const id = createJob();
    ok("intake", "start", "--id", id);
    ok("intake", "start", "--id", id);
    finishIntake(id);
    assert.equal(err("intake", "start", "--id", id),
      `intake already complete for job 001: ${jobPath(id, "intake.md")}`);
  });

  test("complete records the decision, appends the content and deletes the content file", () => {
    const id = createJob();
    ok("intake", "start", "--id", id);
    const content = contentFile("\n## Summary\n\n- accepted\n\n## Scope\n\nA toggle.\n\n");
    const out = ok("intake", "complete", "--id", id, "--content", content, "--outcome", "ACCEPT",
      "--risk", "medium", "--surfaces", "security, ui,,", "--rescoped", "yes");
    assert.equal(out, "intake complete for job 001: ACCEPT\n");

    const text = read(id, "intake.md");
    const meta = fm(text);
    assert.deepEqual(Object.keys(meta),
      ["STATUS", "STARTED", "FINISHED", "OUTCOME", "RISK", "SURFACES", "RESCOPED"]);
    assert.equal(meta.STATUS, "COMPLETE");
    assert.match(meta.FINISHED, ISO);
    assert.equal(meta.OUTCOME, "ACCEPT");
    assert.equal(meta.RISK, "medium");
    assert.equal(meta.SURFACES, "security, ui");
    assert.equal(meta.RESCOPED, "yes");
    assert.equal(body(text), "\n## Summary\n\n- accepted\n\n## Scope\n\nA toggle.\n");
    assert.ok(!existsSync(content));
  });

  test("complete accepts every documented outcome, risk and rescoped value", () => {
    for (const [outcome, risk, rescoped] of [["NEEDS-INFO", "low", "no"], ["REJECT", "high", "yes"]]) {
      const id = createJob();
      finishIntake(id, { outcome, risk, rescoped, surfaces: "ui,ux,security" });
      const meta = fm(read(id, "intake.md"));
      assert.equal(meta.OUTCOME, outcome);
      assert.equal(meta.RISK, risk);
      assert.equal(meta.RESCOPED, rescoped);
      assert.equal(meta.SURFACES, "ui, ux, security");
    }
  });

  test("complete takes a content path relative to the working directory", () => {
    const id = createJob();
    ok("intake", "start", "--id", id);
    writeFileSync(join(SCRATCH, "rel.md"), "relative\n");
    ok("intake", "complete", "--id", id, "--content", "scratch/rel.md", "--outcome", "ACCEPT",
      "--risk", "low", "--surfaces", "none", "--rescoped", "no");
    assert.equal(body(read(id, "intake.md")), "\nrelative\n");
    assert.ok(!existsSync(join(SCRATCH, "rel.md")));
  });

  test("complete lists every missing flag", () => {
    const id = createJob();
    ok("intake", "start", "--id", id);
    assert.equal(err("intake", "complete", "--id", id),
      "intake complete is missing: --content, --outcome, --risk, --surfaces, --rescoped");
    assert.equal(err("intake", "complete"),
      "intake complete is missing: --id, --content, --outcome, --risk, --surfaces, --rescoped");
    assert.equal(err("intake", "complete", "--id", id, "--content", "x", "--outcome", " ", "--risk", "low"),
      "intake complete is missing: --outcome, --surfaces, --rescoped");
  });

  test("complete validates each choice", () => {
    const id = createJob();
    ok("intake", "start", "--id", id);
    const flags = { outcome: "ACCEPT", risk: "low", surfaces: "ui", rescoped: "no" };
    const run = (override) => {
      const values = { ...flags, ...override };
      return err("intake", "complete", "--id", id, "--content", contentFile(),
        ...Object.entries(values).flatMap(([key, value]) => [`--${key}`, value]));
    };
    assert.equal(run({ outcome: "accept" }),
      "bad --outcome: accept. Expected one of: ACCEPT | NEEDS-INFO | REJECT");
    assert.equal(run({ risk: "extreme" }), "bad --risk: extreme. Expected one of: low | medium | high");
    assert.equal(run({ surfaces: "ui,api,db" }),
      "bad --surfaces: api, db. Expected comma-separated one of: ui | ux | security | none");
    assert.equal(run({ surfaces: "  " }), "intake complete is missing: --surfaces");
    assert.equal(run({ rescoped: "maybe" }), "bad --rescoped: maybe. Expected one of: yes | no");
    assert.equal(run({ surfaces: "none,ui" }),
      'bad --surfaces: "none" can\'t be combined with other surfaces');
    assert.equal(fm(read(id, "intake.md")).STATUS, "RUNNING");
  });

  test("complete before start fails", () => {
    const id = createJob();
    assert.equal(err("intake", "complete", "--id", id, "--content", contentFile(), "--outcome", "ACCEPT",
      "--risk", "low", "--surfaces", "none", "--rescoped", "no"),
    'intake not started for job 001. Run "job intake start --id 001" first.');
  });

  test("complete twice fails and keeps the content file", () => {
    const id = createJob();
    finishIntake(id);
    const content = contentFile();
    assert.equal(err("intake", "complete", "--id", id, "--content", content, "--outcome", "REJECT",
      "--risk", "low", "--surfaces", "none", "--rescoped", "no"),
    `intake already complete for job 001: ${jobPath(id, "intake.md")}`);
    assert.ok(existsSync(content));
    assert.equal(fm(read(id, "intake.md")).OUTCOME, "ACCEPT");
  });

  test("complete with a missing content file fails and leaves the step RUNNING", () => {
    const id = createJob();
    ok("intake", "start", "--id", id);
    const missing = join(SCRATCH, "nope.md");
    assert.equal(err("intake", "complete", "--id", id, "--content", missing, "--outcome", "ACCEPT",
      "--risk", "low", "--surfaces", "none", "--rescoped", "no"),
    `missing content file: ${missing}`);
    assert.equal(fm(read(id, "intake.md")).STATUS, "RUNNING");
  });

  test("info prints intake.md's frontmatter", () => {
    const id = createJob();
    finishIntake(id, { surfaces: "ui" });
    const out = ok("intake", "info", "--id", id);
    assert.match(out, /^STATUS: COMPLETE\nSTARTED: .+\nFINISHED: .+\nOUTCOME: ACCEPT\nRISK: low\nSURFACES: ui\nRESCOPED: no\n$/);
  });

  test("info before start fails", () => {
    const id = createJob();
    assert.equal(err("intake", "info", "--id", id), 'intake not started for job 001. Run "job intake start --id 001" first.');
  });

  test("unknown or missing actions fail", () => {
    const id = createJob();
    assert.equal(err("intake", "--id", id), 'unknown command: intake. Run "job help" for usage.');
    assert.equal(err("intake", "finish", "--id", id), 'unknown command: intake finish. Run "job help" for usage.');
  });
});

describe("spec-writer", () => {
  test("start needs intake to exist", () => {
    const id = createJob();
    assert.equal(err("spec-writer", "start", "--id", id),
      "spec-writer needs a complete, accepted intake for job 001 (intake is not started)");
  });

  test("start needs intake to be complete", () => {
    const id = createJob();
    ok("intake", "start", "--id", id);
    assert.equal(err("spec-writer", "start", "--id", id),
      "spec-writer needs a complete, accepted intake for job 001 (intake is RUNNING)");
  });

  test("start needs intake to be accepted", () => {
    for (const outcome of ["NEEDS-INFO", "REJECT"]) {
      const id = createJob();
      finishIntake(id, { outcome });
      assert.equal(err("spec-writer", "start", "--id", id),
        `spec-writer needs a complete, accepted intake for job ${id} (intake is COMPLETE, ${outcome})`);
      assert.ok(!existsSync(jobPath(id, "spec.md")));
    }
  });

  test("start, complete and info on an accepted intake", () => {
    const id = createJob();
    finishIntake(id);
    assert.equal(ok("spec-writer", "start", "--id", id), "spec-writer started for job 001\n");
    assert.equal(fm(read(id, "spec.md")).STATUS, "RUNNING");

    const content = contentFile("# Dark mode\n\n## Requirements\n\n1. A toggle.\n");
    assert.equal(ok("spec-writer", "complete", "--id", id, "--content", content), "spec-writer complete for job 001\n");
    const text = read(id, "spec.md");
    assert.deepEqual(Object.keys(fm(text)), ["STATUS", "STARTED", "FINISHED"]);
    assert.equal(body(text), "\n# Dark mode\n\n## Requirements\n\n1. A toggle.\n");
    assert.ok(!existsSync(content));

    assert.match(ok("spec-writer", "info", "--id", id), /^STATUS: COMPLETE\nSTARTED: .+\nFINISHED: .+\n$/);
    assert.equal(err("spec-writer", "start", "--id", id), `spec-writer already complete for job 001: ${jobPath(id, "spec.md")}`);
  });

  test("complete needs --content", () => {
    const id = createJob();
    finishIntake(id);
    ok("spec-writer", "start", "--id", id);
    assert.equal(err("spec-writer", "complete", "--id", id), "spec-writer complete is missing: --content");
  });

  test("complete and info before start fail", () => {
    const id = createJob();
    const message = 'spec-writer not started for job 001. Run "job spec-writer start --id 001" first.';
    assert.equal(err("spec-writer", "complete", "--id", id, "--content", contentFile()), message);
    assert.equal(err("spec-writer", "info", "--id", id), message);
  });

  test("unknown or missing actions fail", () => {
    const id = createJob();
    assert.equal(err("spec-writer", "--id", id), 'unknown command: spec-writer. Run "job help" for usage.');
    assert.equal(err("spec-writer", "write", "--id", id), 'unknown command: spec-writer write. Run "job help" for usage.');
  });
});

describe("--round", () => {
  test("is required", () => {
    const id = createJob();
    for (const command of ["builder", "gate"]) {
      assert.equal(err(command, "info", "--id", id), `${command} info is missing: --round`);
    }
    assert.equal(err("reviewer", "info", "--id", id, "--reviewer", "ALL"), "reviewer info is missing: --round");
    for (const round of ["", " "]) {
      assert.equal(err("builder", "info", "--id", id, `--round=${round}`), "builder info is missing: --round");
    }
  });

  test("must be a positive integer", () => {
    const id = createJob();
    for (const round of ["0", "01", "-1", "1.5", "two"]) {
      assert.equal(err("builder", "info", "--id", id, `--round=${round}`),
        `bad --round: ${round}. Expected a positive integer like 1.`);
    }
  });
});

describe("builder", () => {
  test("round 1 needs a spec", () => {
    const id = createJob();
    finishIntake(id);
    assert.equal(err("builder", "start", "--id", id, "--round", "1"),
      "builder round 1 needs a complete spec for job 001 (spec is not started)");
    ok("spec-writer", "start", "--id", id);
    assert.equal(err("builder", "start", "--id", id, "--round", "1"),
      "builder round 1 needs a complete spec for job 001 (spec is RUNNING)");
    assert.ok(!existsSync(jobPath(id, "round-1")));
  });

  test("start, complete and info for round 1", () => {
    const id = createJob();
    finishIntake(id);
    finishSpec(id);
    assert.equal(ok("builder", "start", "--id", id, "--round", "1"), "builder started for job 001 (--round 1)\n");
    const started = fm(read(id, "round-1", "build.md"));
    assert.deepEqual(Object.keys(started), ["ROUND", "STATUS", "STARTED"]);
    assert.equal(started.ROUND, "1");
    assert.equal(started.STATUS, "RUNNING");

    // Restarting while RUNNING is allowed.
    ok("builder", "start", "--id", id, "--round", "1");

    const content = contentFile("# Build: Dark mode\n");
    assert.equal(ok("builder", "complete", "--id", id, "--round", "1", "--outcome", "READY", "--content", content),
      "builder complete for job 001 (--round 1): READY\n");
    const text = read(id, "round-1", "build.md");
    assert.deepEqual(Object.keys(fm(text)), ["ROUND", "STATUS", "STARTED", "FINISHED", "OUTCOME"]);
    assert.equal(fm(text).OUTCOME, "READY");
    assert.equal(body(text), "\n# Build: Dark mode\n");
    assert.ok(!existsSync(content));

    assert.match(ok("builder", "info", "--id", id, "--round", "1"), /^ROUND: 1\nSTATUS: COMPLETE\nSTARTED: .+\nFINISHED: .+\nOUTCOME: READY\n$/);
    assert.equal(err("builder", "start", "--id", id, "--round", "1"),
      `builder already complete for job 001 (--round 1): ${jobPath(id, "round-1", "build.md")}`);
  });

  test("later rounds need the previous round's build to be complete", () => {
    const id = createJob();
    finishIntake(id);
    finishSpec(id);
    assert.equal(err("builder", "start", "--id", id, "--round", "2"),
      "builder round 2 needs a complete round 1 build for job 001 (round 1 build is not started)");
    ok("builder", "start", "--id", id, "--round", "1");
    assert.equal(err("builder", "start", "--id", id, "--round", "2"),
      "builder round 2 needs a complete round 1 build for job 001 (round 1 build is RUNNING)");
    ok("builder", "complete", "--id", id, "--round", "1", "--outcome", "BLOCKED", "--content", contentFile());
    assert.equal(ok("builder", "start", "--id", id, "--round", "2"), "builder started for job 001 (--round 2)\n");
    assert.equal(fm(read(id, "round-2", "build.md")).ROUND, "2");
    assert.equal(err("builder", "start", "--id", id, "--round", "3"),
      "builder round 3 needs a complete round 2 build for job 001 (round 2 build is RUNNING)");
  });

  test("complete needs --content and a READY|BLOCKED --outcome", () => {
    const id = createJob();
    finishIntake(id);
    finishSpec(id);
    ok("builder", "start", "--id", id, "--round", "1");
    assert.equal(err("builder", "complete", "--id", id, "--round", "1"), "builder complete is missing: --content, --outcome");
    assert.equal(err("builder", "complete", "--id", id, "--round", "1", "--outcome", "DONE", "--content", contentFile()),
      "bad --outcome: DONE. Expected one of: READY | BLOCKED");
    assert.equal(fm(read(id, "round-1", "build.md")).STATUS, "RUNNING");
  });

  test("complete and info before start fail with the round in the hint", () => {
    const id = createJob();
    const message = 'builder not started for job 001 (--round 2). Run "job builder start --id 001 --round 2" first.';
    assert.equal(err("builder", "complete", "--id", id, "--round", "2", "--outcome", "READY", "--content", contentFile()), message);
    assert.equal(err("builder", "info", "--id", id, "--round", "2"), message);
  });

  test("unknown or missing actions fail", () => {
    const id = createJob();
    assert.equal(err("builder", "--id", id, "--round", "1"), 'unknown command: builder. Run "job help" for usage.');
    assert.equal(err("builder", "build", "--id", id, "--round", "1"), 'unknown command: builder build. Run "job help" for usage.');
  });
});

describe("gate", () => {
  // A job whose round-1 build has started, with a worktree, ready for `gate check`.
  function building() {
    const id = createJob();
    finishIntake(id);
    finishSpec(id);
    ok("builder", "start", "--id", id, "--round", "1");
    makeWorktree(id);
    return id;
  }

  const gateFile = (id, round = 1) => read(id, `round-${round}`, "gate.md");

  test("check needs the build round to be started", () => {
    const id = createJob();
    assert.equal(err("gate", "check", "--id", id, "--round", "1"),
      'gate needs build round 1 started for job 001. Run "job builder start --id 001 --round 1" first.');
  });

  test("check passes when every command exits 0, and runs inside the worktree", () => {
    const id = building();
    setGate(["pwd", "echo lint ok && echo warn >&2"]);
    assert.equal(ok("gate", "check", "--id", id, "--round", "1"), "GATE: PASS\n");

    const text = gateFile(id);
    const meta = fm(text);
    assert.deepEqual(Object.keys(meta), ["ROUND", "STATUS", "STARTED", "FINISHED", "OUTCOME"]);
    assert.equal(meta.ROUND, "1");
    assert.equal(meta.STATUS, "COMPLETE");
    assert.match(meta.STARTED, ISO);
    assert.match(meta.FINISHED, ISO);
    assert.equal(meta.OUTCOME, "PASS");

    assert.match(text, /## `pwd` — PASSED\n\n<details>\n<summary>Logs \(exit 0, \d+\.\ds\)<\/summary>\n\n```\n(.+)\n```\n\n<\/details>\n/);
    assert.equal(text.match(/```\n(.+)\n```/)[1], join(WORKTREES, id));
    assert.match(text, /## `echo lint ok && echo warn >&2` — PASSED\n[\s\S]*```\nlint ok\nwarn\n```/);

    assert.match(ok("gate", "info", "--id", id, "--round", "1"),
      /^ROUND: 1\nSTATUS: COMPLETE\nSTARTED: .+\nFINISHED: .+\nOUTCOME: PASS\n$/);
  });

  test("check runs while the build is still RUNNING (the builder runs it)", () => {
    const id = building();
    setGate(["true"]);
    ok("gate", "check", "--id", id, "--round", "1");
    assert.equal(fm(read(id, "round-1", "build.md")).STATUS, "RUNNING");
  });

  test("check fails with exit 1 when any command fails, but still runs them all", () => {
    const id = building();
    setGate(["echo boom; exit 3", "echo after"]);
    const result = job("gate", "check", "--id", id, "--round", "1");
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "GATE: FAIL\n");
    assert.equal(result.stderr, "");

    const text = gateFile(id);
    assert.equal(fm(text).OUTCOME, "FAIL");
    assert.match(text, /## `echo boom; exit 3` — FAILED\n\n<details>\n<summary>Logs \(exit 3, /);
    assert.match(text, /```\nboom\n```/);
    assert.match(text, /## `echo after` — PASSED/);
    assert.match(ok("gate", "info", "--id", id, "--round", "1"), /OUTCOME: FAIL/);
  });

  test("the shipped config.json gate fails until the repo configures it", () => {
    const id = building();
    const result = job("gate", "check", "--id", id, "--round", "1");
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "GATE: FAIL\n");
    assert.match(gateFile(id), /config\.json -> gate has no checks yet/);
  });

  test("gate.md is rewritten as each command starts and finishes", () => {
    const id = building();
    // The first command prints gate.md as it is while that command runs.
    const live = join("..", "..", "skills", "factory", "jobs", id, "round-1", "gate.md");
    setGate([`cat ${live}`, "true"]);
    ok("gate", "check", "--id", id, "--round", "1");

    const log = gateFile(id).match(/<summary>.*\n\n```\n([\s\S]*?)\n```/)[1];
    assert.match(log, /^---\nROUND: 1\nSTATUS: RUNNING\nSTARTED: .+\n---\n/);
    assert.match(log, new RegExp(`## \`cat ${live.replace(/\./g, "\\.")}\` — RUNNING\n`));
    assert.match(log, /## `true` — PENDING$/);
    assert.doesNotMatch(log, /OUTCOME/);
  });

  test("re-running check starts gate.md over", () => {
    const id = building();
    setGate(["false"]);
    assert.equal(job("gate", "check", "--id", id, "--round", "1").code, 1);
    setGate(["true"]);
    ok("gate", "check", "--id", id, "--round", "1");
    const text = gateFile(id);
    assert.equal(fm(text).OUTCOME, "PASS");
    assert.doesNotMatch(text, /false/);
  });

  test("a command with no output logs (no output)", () => {
    const id = building();
    setGate(["true"]);
    ok("gate", "check", "--id", id, "--round", "1");
    assert.match(gateFile(id), /```\n\(no output\)\n```/);
  });

  test("logs containing backtick fences get a longer fence", () => {
    const id = building();
    setGate(["printf '````js\\nx\\n````\\n'"]);
    ok("gate", "check", "--id", id, "--round", "1");
    assert.match(gateFile(id), /\n`````\n````js\nx\n````\n`````\n/);
  });

  test("commands containing backticks are wrapped in longer code spans", () => {
    const id = building();
    setGate(["echo '```' > /dev/null", "echo `echo ok`", "`true`"]);
    ok("gate", "check", "--id", id, "--round", "1");
    const text = gateFile(id);
    assert.ok(text.includes("## ````echo '```' > /dev/null```` — PASSED\n"));
    // A span that starts or ends with a backtick is padded with spaces.
    assert.ok(text.includes("## `` echo `echo ok` `` — PASSED\n"));
    assert.ok(text.includes("## `` `true` `` — PASSED\n"));
  });

  test("a command killed by a signal fails and says so", () => {
    const id = building();
    setGate(["echo dying; kill -9 $$"]);
    assert.equal(job("gate", "check", "--id", id, "--round", "1").code, 1);
    const text = gateFile(id);
    assert.match(text, /— FAILED\n\n<details>\n<summary>Logs \(exit 1, /);
    assert.match(text, /```\ndying\n\nkilled by SIGKILL\n```/);
  });

  test("a command that can't be spawned fails with the spawn error", () => {
    const id = createJob();
    finishIntake(id);
    finishSpec(id);
    ok("builder", "start", "--id", id, "--round", "1");
    // The worktree exists but isn't a directory, so the shell can't start in it.
    writeFileSync(join(SANDBOX, "not-a-dir"), "");
    write(id, "job.md", read(id, "job.md").replace(/WORKTREE: .*/, `WORKTREE: ${join(SANDBOX, "not-a-dir")}`));
    setGate(["true"]);
    assert.equal(job("gate", "check", "--id", id, "--round", "1").code, 1);
    assert.match(gateFile(id), /\(exit 1, [\s\S]*```\n\nspawnSync \/bin\/sh ENOTDIR\n```/);
  });

  test("check needs the job's worktree to exist", () => {
    const id = createJob();
    finishIntake(id);
    finishSpec(id);
    ok("builder", "start", "--id", id, "--round", "1");
    setGate(["true"]);
    assert.equal(err("gate", "check", "--id", id, "--round", "1"),
      `missing worktree for job 001: ${join(WORKTREES, id)}`);

    write(id, "job.md", read(id, "job.md").replace(/WORKTREE: .*\n/, ""));
    assert.equal(err("gate", "check", "--id", id, "--round", "1"),
      "missing worktree for job 001: (no WORKTREE in job.md)");
    assert.ok(!existsSync(jobPath(id, "round-1", "gate.md")));
  });

  test("check validates config.json -> gate", () => {
    const id = building();
    const invalid = `config.json -> gate must be a non-empty list of commands: ${CONFIG}`;
    for (const config of [{}, { gate: "npm test" }, { gate: [] }, { gate: ["npm test", 1] }, { gate: ["npm test", "  "] }]) {
      writeFileSync(CONFIG, JSON.stringify(config));
      assert.equal(err("gate", "check", "--id", id, "--round", "1"), invalid);
    }
    assert.ok(!existsSync(jobPath(id, "round-1", "gate.md")));
  });

  test("check fails on a missing or unparseable config.json", () => {
    const id = building();
    rmSync(CONFIG);
    assert.equal(err("gate", "check", "--id", id, "--round", "1"), `missing config: ${CONFIG}`);
    writeFileSync(CONFIG, "{ not json");
    assert.match(err("gate", "check", "--id", id, "--round", "1"), /SyntaxError/);
  });

  test("info before check fails", () => {
    const id = createJob();
    assert.match(err("gate", "info", "--id", id, "--round", "1"), /^gate not started for job 001 \(--round 1\)\./);
  });

  test("unknown or missing actions fail", () => {
    const id = createJob();
    assert.equal(err("gate", "--id", id, "--round", "1"), 'unknown command: gate. Run "job help" for usage.');
    assert.equal(err("gate", "start", "--id", id, "--round", "1"), 'unknown command: gate start. Run "job help" for usage.');
  });
});

describe("reviewer", () => {
  test("needs a complete intake", () => {
    const id = createJob();
    assert.equal(err("reviewer", "info", "--id", id, "--round", "1", "--reviewer", "ALL"),
      "reviewer needs a complete intake for job 001");
    ok("intake", "start", "--id", id);
    assert.equal(err("reviewer", "start", "--id", id, "--round", "1", "--reviewer", "code"),
      "reviewer needs a complete intake for job 001");
  });

  test("needs --reviewer", () => {
    const id = readyForReview();
    assert.equal(err("reviewer", "start", "--id", id, "--round", "1"), "reviewer start is missing: --reviewer");
    assert.equal(err("reviewer", "info", "--id", id, "--round", "1"), "reviewer info is missing: --reviewer");
  });

  test("rejects unknown reviewers, and ALL outside of info", () => {
    const id = readyForReview();
    assert.equal(err("reviewer", "start", "--id", id, "--round", "1", "--reviewer", "perf"),
      "bad --reviewer: perf. Expected one of: code | security | ui | ux");
    assert.equal(err("reviewer", "start", "--id", id, "--round", "1", "--reviewer", "ALL"),
      "bad --reviewer: ALL. Expected one of: code | security | ui | ux");
  });

  test("only reviewers intake flagged in SURFACES (plus code) are allowed", () => {
    const id = readyForReview({ surfaces: "ui" });
    assert.equal(err("reviewer", "start", "--id", id, "--round", "1", "--reviewer", "security"),
      "reviewer security isn't needed for job 001. Needed: code, ui");
    assert.equal(err("reviewer", "start", "--id", id, "--round", "1", "--reviewer", "ux"),
      "reviewer ux isn't needed for job 001. Needed: code, ui");
  });

  test("start needs a passing gate", () => {
    const id = createJob();
    finishIntake(id);
    finishSpec(id);
    finishBuild(id);
    const start = () => err("reviewer", "start", "--id", id, "--round", "1", "--reviewer", "code");
    assert.equal(start(), "reviewer needs a passing gate for job 001 round 1 (gate is not started)");

    makeWorktree(id);
    setGate(["false"]);
    job("gate", "check", "--id", id, "--round", "1");
    assert.equal(start(), "reviewer needs a passing gate for job 001 round 1 (gate is COMPLETE, FAIL)");

    write(id, "round-1/gate.md", "---\nROUND: 1\nSTATUS: RUNNING\n---\n");
    assert.equal(start(), "reviewer needs a passing gate for job 001 round 1 (gate is RUNNING)");
    assert.ok(!existsSync(jobPath(id, "round-1", "review-code.md")));
  });

  test("start, complete and info for one reviewer", () => {
    const id = readyForReview({ surfaces: "security" });
    assert.equal(ok("reviewer", "start", "--id", id, "--round", "1", "--reviewer", "security"),
      "reviewer started for job 001 (--round 1 --reviewer security)\n");
    const started = fm(read(id, "round-1", "review-security.md"));
    assert.deepEqual(Object.keys(started), ["REVIEWER", "ROUND", "STATUS", "STARTED"]);
    assert.equal(started.REVIEWER, "security");
    assert.equal(started.ROUND, "1");

    const content = contentFile("## Findings\n\n1. src/api.js:10 unescaped input\n");
    assert.equal(ok("reviewer", "complete", "--id", id, "--round", "1", "--reviewer", "security",
      "--outcome", "CHANGES", "--content", content),
    "reviewer complete for job 001 (--round 1 --reviewer security): CHANGES\n");
    const text = read(id, "round-1", "review-security.md");
    assert.equal(fm(text).OUTCOME, "CHANGES");
    assert.equal(body(text), "\n## Findings\n\n1. src/api.js:10 unescaped input\n");
    assert.ok(!existsSync(content));

    assert.match(ok("reviewer", "info", "--id", id, "--round", "1", "--reviewer", "security"),
      /^REVIEWER: security\nROUND: 1\nSTATUS: COMPLETE\nSTARTED: .+\nFINISHED: .+\nOUTCOME: CHANGES\n$/);
    assert.equal(err("reviewer", "start", "--id", id, "--round", "1", "--reviewer", "security"),
      `reviewer already complete for job 001 (--round 1 --reviewer security): ${jobPath(id, "round-1", "review-security.md")}`);
  });

  test("complete needs --content and a PASS|CHANGES --outcome", () => {
    const id = readyForReview();
    ok("reviewer", "start", "--id", id, "--round", "1", "--reviewer", "code");
    assert.equal(err("reviewer", "complete", "--id", id, "--round", "1", "--reviewer", "code"),
      "reviewer complete is missing: --content, --outcome");
    assert.equal(err("reviewer", "complete", "--id", id, "--round", "1", "--reviewer", "code",
      "--outcome", "APPROVE", "--content", contentFile()),
    "bad --outcome: APPROVE. Expected one of: PASS | CHANGES");
  });

  test("complete and info before start fail with the round and reviewer in the hint", () => {
    const id = readyForReview();
    const message = 'reviewer not started for job 001 (--round 1 --reviewer code). Run "job reviewer start --id 001 --round 1 --reviewer code" first.';
    assert.equal(err("reviewer", "complete", "--id", id, "--round", "1", "--reviewer", "code",
      "--outcome", "PASS", "--content", contentFile()), message);
    assert.equal(err("reviewer", "info", "--id", id, "--round", "1", "--reviewer", "code"), message);
  });

  test("info ALL prints every needed reviewer, NOT-STARTED for those that haven't begun", () => {
    const id = readyForReview({ surfaces: "ux,security,ui" });
    ok("reviewer", "start", "--id", id, "--round", "1", "--reviewer", "ux");
    ok("reviewer", "start", "--id", id, "--round", "1", "--reviewer", "code");
    ok("reviewer", "complete", "--id", id, "--round", "1", "--reviewer", "code", "--outcome", "PASS", "--content", contentFile());

    const sections = ok("reviewer", "info", "--id", id, "--round", "1", "--reviewer", "ALL").trimEnd().split("\n\n");
    assert.equal(sections.length, 4);
    assert.match(sections[0], /^## code\nREVIEWER: code\nROUND: 1\nSTATUS: COMPLETE\nSTARTED: .+\nFINISHED: .+\nOUTCOME: PASS$/);
    assert.equal(sections[1], "## security\nREVIEWER: security\nROUND: 1\nSTATUS: NOT-STARTED");
    assert.equal(sections[2], "## ui\nREVIEWER: ui\nROUND: 1\nSTATUS: NOT-STARTED");
    assert.match(sections[3], /^## ux\nREVIEWER: ux\nROUND: 1\nSTATUS: RUNNING\nSTARTED: .+$/);
  });

  test("info ALL for a job with no extra surfaces lists only code", () => {
    const id = readyForReview({ surfaces: "none" });
    assert.equal(ok("reviewer", "info", "--id", id, "--round", "2", "--reviewer", "ALL"),
      "## code\nREVIEWER: code\nROUND: 2\nSTATUS: NOT-STARTED\n");
  });

  test("unknown or missing actions fail", () => {
    const id = readyForReview();
    assert.equal(err("reviewer", "--id", id, "--round", "1", "--reviewer", "code"),
      'unknown command: reviewer. Run "job help" for usage.');
    assert.equal(err("reviewer", "approve", "--id", id, "--round", "1", "--reviewer", "code"),
      'unknown command: reviewer approve. Run "job help" for usage.');
  });
});

describe("approver", () => {
  // A job whose round-1 gate and every needed review passed.
  function readyForApproval(intake = {}) {
    const id = readyForReview(intake);
    passReviews(id);
    return id;
  }

  test("start needs a build round", () => {
    const id = createJob();
    finishIntake(id);
    finishSpec(id);
    // Folders that aren't round-<N> don't count.
    mkdirSync(jobPath(id, "round-0"));
    mkdirSync(jobPath(id, "round-x"));
    assert.equal(err("approver", "start", "--id", id), "approver needs a build round for job 001 (no rounds yet)");
    assert.ok(!existsSync(jobPath(id, "decision.md")));
  });

  test("start needs the latest round's gate to pass", () => {
    const id = createJob();
    finishIntake(id);
    finishSpec(id);
    finishBuild(id);
    assert.equal(err("approver", "start", "--id", id),
      "approver needs a passing gate for job 001 round 1 (gate is not started)");

    makeWorktree(id);
    setGate(["false"]);
    job("gate", "check", "--id", id, "--round", "1");
    assert.equal(err("approver", "start", "--id", id),
      "approver needs a passing gate for job 001 round 1 (gate is COMPLETE, FAIL)");

    // A passing earlier round doesn't count once a later round exists.
    setGate(["true"]);
    ok("gate", "check", "--id", id, "--round", "1");
    passReviews(id, 1);
    finishBuild(id, 2);
    assert.equal(err("approver", "start", "--id", id),
      "approver needs a passing gate for job 001 round 2 (gate is not started)");
    assert.ok(!existsSync(jobPath(id, "decision.md")));
  });

  test("start needs every needed review in the latest round to pass", () => {
    const id = readyForReview({ surfaces: "ui" });
    ok("reviewer", "start", "--id", id, "--round", "1", "--reviewer", "code");
    assert.equal(err("approver", "start", "--id", id),
      "approver needs every review to pass for job 001 round 1. Not passed: code (RUNNING), ui (not started)");

    ok("reviewer", "complete", "--id", id, "--round", "1", "--reviewer", "code",
      "--outcome", "CHANGES", "--content", contentFile());
    ok("reviewer", "start", "--id", id, "--round", "1", "--reviewer", "ui");
    ok("reviewer", "complete", "--id", id, "--round", "1", "--reviewer", "ui",
      "--outcome", "PASS", "--content", contentFile());
    assert.equal(err("approver", "start", "--id", id),
      "approver needs every review to pass for job 001 round 1. Not passed: code (COMPLETE, CHANGES)");
    assert.ok(!existsSync(jobPath(id, "decision.md")));
  });

  test("start, complete and info write decision.md", () => {
    const id = readyForApproval({ surfaces: "security" });
    assert.equal(ok("approver", "start", "--id", id), "approver started for job 001\n");
    const started = fm(read(id, "decision.md"));
    assert.deepEqual(Object.keys(started), ["ROUND", "STATUS", "STARTED"]);
    assert.equal(started.ROUND, "1");
    assert.equal(started.STATUS, "RUNNING");

    // Restarting while RUNNING is allowed.
    ok("approver", "start", "--id", id);

    const content = contentFile("> **Auto-merge: no human review needed**\n\n## Summary\n\n- done\n");
    assert.equal(ok("approver", "complete", "--id", id, "--outcome", "APPROVE", "--content", content),
      "approver complete for job 001: APPROVE\n");
    const text = read(id, "decision.md");
    assert.deepEqual(Object.keys(fm(text)), ["ROUND", "STATUS", "STARTED", "FINISHED", "OUTCOME"]);
    assert.equal(fm(text).OUTCOME, "APPROVE");
    assert.equal(body(text), "\n> **Auto-merge: no human review needed**\n\n## Summary\n\n- done\n");
    assert.ok(!existsSync(content));

    assert.match(ok("approver", "info", "--id", id),
      /^ROUND: 1\nSTATUS: COMPLETE\nSTARTED: .+\nFINISHED: .+\nOUTCOME: APPROVE\n$/);
    assert.equal(err("approver", "start", "--id", id),
      `approver already complete for job 001: ${jobPath(id, "decision.md")}`);
  });

  test("complete needs --content and an APPROVE|ESCALATE --outcome", () => {
    const id = readyForApproval();
    ok("approver", "start", "--id", id);
    assert.equal(err("approver", "complete", "--id", id), "approver complete is missing: --content, --outcome");
    assert.equal(err("approver", "complete", "--id", id, "--outcome", "PASS", "--content", contentFile()),
      "bad --outcome: PASS. Expected one of: APPROVE | ESCALATE");
    assert.equal(fm(read(id, "decision.md")).STATUS, "RUNNING");
  });

  test("complete and info before start fail", () => {
    const id = createJob();
    const message = 'approver not started for job 001. Run "job approver start --id 001" first.';
    assert.equal(err("approver", "complete", "--id", id, "--outcome", "APPROVE", "--content", contentFile()), message);
    assert.equal(err("approver", "info", "--id", id), message);
  });

  test("an ESCALATE can only be replaced by a decision on a later round", () => {
    const id = readyForApproval();
    finishApprover(id, "ESCALATE");
    assert.equal(err("approver", "start", "--id", id),
      `approver already complete for job 001: ${jobPath(id, "decision.md")}`);

    // The user's feedback starts round 2, which needs a new decision.
    finishBuild(id, 2);
    passGate(id, 2);
    passReviews(id, 2);
    assert.equal(ok("approver", "start", "--id", id), "approver started for job 001\n");
    const meta = fm(read(id, "decision.md"));
    assert.deepEqual(Object.keys(meta), ["ROUND", "STATUS", "STARTED"]);
    assert.equal(meta.ROUND, "2");
  });

  test("an APPROVE is never replaced, even by a later round", () => {
    const id = readyForApproval();
    finishApprover(id, "APPROVE");
    finishBuild(id, 2);
    passGate(id, 2);
    passReviews(id, 2);
    assert.equal(err("approver", "start", "--id", id),
      `approver already complete for job 001: ${jobPath(id, "decision.md")}`);
    assert.equal(fm(read(id, "decision.md")).ROUND, "1");
  });

  test("unknown or missing actions fail", () => {
    const id = createJob();
    assert.equal(err("approver", "--id", id), 'unknown command: approver. Run "job help" for usage.');
    assert.equal(err("approver", "approve", "--id", id), 'unknown command: approver approve. Run "job help" for usage.');
  });
});

describe("pull requests", () => {
  // A job with a RUNNING approver, a config whose pull_request lists are
  // `APPROVE` and `ESCALATE`, and a worktree.
  function approving({ APPROVE = [], ESCALATE = [], base_branch = "main", title, prompt } = {}) {
    const id = createJob(prompt, title);
    finishIntake(id);
    finishSpec(id);
    finishBuild(id);
    passGate(id);
    passReviews(id);
    ok("approver", "start", "--id", id);
    setGate(["true"], { pull_request: { APPROVE, ESCALATE }, base_branch });
    return id;
  }

  const complete = (id, outcome, content) => job("approver", "complete", "--id", id, "--outcome", outcome, "--content", content);
  const env = "echo \"$FACTORY_ID|$FACTORY_TITLE|$FACTORY_BRANCH|$FACTORY_BASE|$FACTORY_WORKTREE|$FACTORY_OUTCOME|$FACTORY_SCRIPTS\"";

  test("APPROVE runs pull_request.APPROVE in the worktree with the job's variables, then records the decision", () => {
    const id = approving({
      title: `Fix "quotes" & $(rm -rf ~); safely`,
      APPROVE: ["pwd", env, 'cat "$FACTORY_BODY_FILE"'],
      ESCALATE: ["echo wrong list; exit 1"],
      base_branch: "develop",
    });
    const content = contentFile("> **Auto-merge: no human review needed**\n\n## Summary\n");
    assert.equal(ok("approver", "complete", "--id", id, "--outcome", "APPROVE", "--content", content),
      "approver complete for job 001: APPROVE\n");

    const pr = read(id, "pr.md");
    const meta = fm(pr);
    assert.deepEqual(Object.keys(meta), ["DECISION", "STATUS", "STARTED", "FINISHED", "OUTCOME"]);
    assert.equal(meta.DECISION, "APPROVE");
    assert.equal(meta.STATUS, "COMPLETE");
    assert.equal(meta.OUTCOME, "PASS");
    const logs = [...pr.matchAll(/```\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    const worktree = join(WORKTREES, id);
    // The title reaches the command as data: quoted, it never runs as shell.
    assert.deepEqual(logs, [
      worktree,
      `001|Fix "quotes" & $(rm -rf ~); safely|factory/001|develop|${worktree}|APPROVE|${join(FACTORY, "scripts")}`,
      "> **Auto-merge: no human review needed**\n\n## Summary",
    ]);

    assert.equal(fm(read(id, "decision.md")).OUTCOME, "APPROVE");
    assert.ok(!existsSync(content));
  });

  test("ESCALATE runs pull_request.ESCALATE", () => {
    const id = approving({ APPROVE: ["echo wrong list; exit 1"], ESCALATE: [env] });
    assert.equal(complete(id, "ESCALATE", contentFile()).code, 0);
    const pr = read(id, "pr.md");
    assert.equal(fm(pr).DECISION, "ESCALATE");
    assert.match(pr, /\|ESCALATE\|/);
    assert.equal(fm(read(id, "decision.md")).OUTCOME, "ESCALATE");
  });

  test("a failing command skips the rest, leaves the decision RUNNING, and can be retried", () => {
    const id = approving({ APPROVE: ["echo pushed", "echo 'gh: not logged in' >&2; exit 4", "echo merged"] });
    const content = contentFile();
    const result = complete(id, "APPROVE", content);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), `pull request failed for job 001, see ${jobPath(id, "pr.md")}. ` +
      "decision.md is still RUNNING: fix the cause and run approver complete again.");

    const pr = read(id, "pr.md");
    assert.equal(fm(pr).OUTCOME, "FAIL");
    assert.match(pr, /## `echo pushed` — PASSED/);
    assert.match(pr, /— FAILED\n\n<details>\n<summary>Logs \(exit 4, [\s\S]*```\ngh: not logged in\n```/);
    assert.match(pr, /## `echo merged` — SKIPPED\n$/);
    assert.equal(fm(read(id, "decision.md")).STATUS, "RUNNING");
    assert.ok(existsSync(content));

    // Fixed: running approver complete again starts pr.md over.
    setGate(["true"], { pull_request: { APPROVE: ["echo merged"], ESCALATE: [] } });
    assert.equal(complete(id, "APPROVE", content).code, 0);
    assert.equal(fm(read(id, "pr.md")).OUTCOME, "PASS");
    assert.doesNotMatch(read(id, "pr.md"), /not logged in/);
    assert.equal(fm(read(id, "decision.md")).STATUS, "COMPLETE");
  });

  test("an empty list opens no pull request", () => {
    const id = approving();
    assert.equal(complete(id, "APPROVE", contentFile()).code, 0);
    assert.ok(!existsSync(jobPath(id, "pr.md")));
    assert.equal(fm(read(id, "decision.md")).OUTCOME, "APPROVE");
  });

  test("nothing runs until the step and content file check out", () => {
    const id = approving({ APPROVE: ["true"] });
    assert.equal(err("approver", "complete", "--id", id, "--outcome", "APPROVE", "--content", join(SCRATCH, "nope.md")),
      `missing content file: ${join(SCRATCH, "nope.md")}`);
    assert.ok(!existsSync(jobPath(id, "pr.md")));

    finishApprover(id);
    assert.equal(err("approver", "complete", "--id", id, "--outcome", "APPROVE", "--content", contentFile()),
      `approver already complete for job 001: ${jobPath(id, "decision.md")}`);
  });

  test("pull_request must list commands for the outcome", () => {
    const id = approving();
    const invalid = (outcome) => `config.json -> pull_request.${outcome} must be a list of commands: ${CONFIG}`;
    for (const pull_request of [undefined, {}, { APPROVE: "git push" }, { APPROVE: [""] }, { APPROVE: [1] }]) {
      writeFileSync(CONFIG, JSON.stringify({ base_branch: "main", gate: ["true"], pull_request }));
      assert.equal(err("approver", "complete", "--id", id, "--outcome", "APPROVE", "--content", contentFile()), invalid("APPROVE"));
    }
    writeFileSync(CONFIG, JSON.stringify({ base_branch: "main", gate: ["true"], pull_request: { APPROVE: [] } }));
    assert.equal(err("approver", "complete", "--id", id, "--outcome", "ESCALATE", "--content", contentFile()), invalid("ESCALATE"));
    assert.equal(fm(read(id, "decision.md")).STATUS, "RUNNING");
  });

  test("base_branch must be a branch name", () => {
    const id = approving({ APPROVE: ["true"] });
    for (const base_branch of ["", "  ", 3]) {
      setGate(["true"], { pull_request: { APPROVE: ["true"] }, base_branch });
      assert.equal(err("approver", "complete", "--id", id, "--outcome", "APPROVE", "--content", contentFile()),
        `config.json -> base_branch must be a branch name: ${CONFIG}`);
    }
  });

  test("needs a TITLE in job.md and the job's worktree", () => {
    const id = approving({ APPROVE: ["true"] });
    const original = read(id, "job.md");
    write(id, "job.md", original.replace(/TITLE: .*\n/, ""));
    assert.equal(err("approver", "complete", "--id", id, "--outcome", "APPROVE", "--content", contentFile()),
      "job 001 has no TITLE in job.md, so its pull request has no title");

    write(id, "job.md", original);
    rmSync(join(WORKTREES, id), { recursive: true });
    assert.equal(err("approver", "complete", "--id", id, "--outcome", "APPROVE", "--content", contentFile()),
      `missing worktree for job 001: ${join(WORKTREES, id)}`);
    assert.ok(!existsSync(jobPath(id, "pr.md")));
  });

  test("the shipped config.json runs the GitHub script for both outcomes", () => {
    const { pull_request } = JSON.parse(readFileSync(join(REAL_FACTORY, "config.json"), "utf8"));
    const github = ['sh "$FACTORY_SCRIPTS/github/pull-request.sh"'];
    assert.deepEqual(pull_request, { APPROVE: github, ESCALATE: github });
  });
});

describe("frontmatter files edited by hand", () => {
  test("a job folder without job.md", () => {
    mkdirSync(jobPath("007"), { recursive: true });
    assert.equal(err("info", "--id", "007"), `missing file: ${jobPath("007", "job.md")}`);
  });

  test("a file that doesn't start with ---", () => {
    const id = createJob();
    write(id, "job.md", "# Job\n---\nID: 001\n---\n");
    assert.equal(err("info", "--id", id), `no frontmatter in ${jobPath(id, "job.md")}`);
  });

  test("a file whose frontmatter never closes", () => {
    const id = createJob();
    write(id, "job.md", "---\nID: 001\n");
    assert.equal(err("info", "--id", id), `unclosed frontmatter in ${jobPath(id, "job.md")}`);
  });

  test("a frontmatter line without a colon", () => {
    const id = createJob();
    write(id, "intake.md", "---\nSTATUS: COMPLETE\noops\n---\n");
    assert.equal(err("spec-writer", "start", "--id", id), `bad frontmatter line in ${jobPath(id, "intake.md")}: oops`);
  });

  test("CRLF line endings, indentation, blank lines, # comments and quoted values are tolerated", () => {
    const id = createJob();
    write(id, "intake.md", [
      "---  ",
      "# written by hand",
      "  STATUS:  'COMPLETE'  ",
      "",
      'OUTCOME: "ACCEPT"',
      "NOTE: a: b",
      "---",
      "body",
    ].join("\r\n"));
    assert.equal(ok("intake", "info", "--id", id),
      "# written by hand\nSTATUS:  'COMPLETE'\nOUTCOME: \"ACCEPT\"\nNOTE: a: b\n");
    // readFrontmatter unquotes values, so the hand-written intake counts as accepted...
    assert.equal(ok("spec-writer", "start", "--id", id), "spec-writer started for job 001\n");
    // ...and with no SURFACES line, only the code reviewer is needed.
    assert.equal(ok("reviewer", "info", "--id", id, "--round", "1", "--reviewer", "ALL"),
      "## code\nREVIEWER: code\nROUND: 1\nSTATUS: NOT-STARTED\n");
  });
});

describe("the build pipeline end to end", () => {
  test("create → intake → spec → build/gate rounds → reviews → approver", () => {
    const id = createJob("Add a dark mode toggle to the settings page");
    makeWorktree(id);

    finishIntake(id, { surfaces: "ui,security", risk: "medium" });
    assert.match(ok("intake", "info", "--id", id), /OUTCOME: ACCEPT\nRISK: medium\nSURFACES: ui, security\n/);
    finishSpec(id);

    // Round 1: the gate fails, so no reviewer may start; the builder goes again.
    finishBuild(id, 1);
    setGate(["echo 'tests failed' >&2; exit 1"]);
    assert.equal(job("gate", "check", "--id", id, "--round", "1").code, 1);
    assert.match(ok("gate", "info", "--id", id, "--round", "1"), /OUTCOME: FAIL/);
    assert.match(err("reviewer", "start", "--id", id, "--round", "1", "--reviewer", "code"), /needs a passing gate/);

    // Round 2: the gate passes and every needed reviewer runs.
    finishBuild(id, 2);
    setGate(["true", "echo built"]);
    assert.equal(ok("gate", "check", "--id", id, "--round", "2"), "GATE: PASS\n");
    for (const name of ["code", "security", "ui"]) {
      ok("reviewer", "start", "--id", id, "--round", "2", "--reviewer", name);
      ok("reviewer", "complete", "--id", id, "--round", "2", "--reviewer", name, "--outcome", "PASS", "--content", contentFile());
    }
    const verdicts = ok("reviewer", "info", "--id", id, "--round", "2", "--reviewer", "ALL");
    assert.deepEqual(verdicts.match(/^## \w+$/gm), ["## code", "## security", "## ui"]);
    assert.equal(verdicts.match(/OUTCOME: PASS/g).length, 3);

    finishApprover(id, "APPROVE");
    assert.match(ok("approver", "info", "--id", id), /^ROUND: 2\n[\s\S]*OUTCOME: APPROVE\n$/);

    assert.deepEqual(
      ["job.md", "intake.md", "spec.md", "round-1/build.md", "round-1/gate.md", "round-2/build.md",
        "round-2/gate.md", "round-2/review-code.md", "round-2/review-security.md", "round-2/review-ui.md", "decision.md"]
        .filter((file) => !existsSync(jobPath(id, file))),
      [],
    );
  });
});
