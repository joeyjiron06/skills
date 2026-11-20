// Tests for the pull request scripts in skills/factory/scripts/<host>/.
//
// Run from the repo root with the job.js tests: `node --test`.
//
// Each script runs the way `job approver complete` runs it: `sh <script>` in a
// worktree with the $FACTORY_* variables set. git, gh and az are fakes on PATH
// that log every call (one line per call, each argument in [brackets]) to
// calls.log and answer from the environment, so no test touches a real host.

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SCRIPTS = resolve(import.meta.dirname, "..", "skills", "factory", "scripts");
const SANDBOX = join(import.meta.dirname, ".sandbox-pr");
const BIN = join(SANDBOX, "bin");
const WORKTREE = join(SANDBOX, "worktree");
const LOG = join(SANDBOX, "calls.log");
const BODY = join(SANDBOX, "body.md");

// Every fake logs its call. Answers come from FAKE_* variables.
const LOG_CALL = `printf '%s' "$(basename "$0")" >> "$FAKE_LOG"; printf ' [%s]' "$@" >> "$FAKE_LOG"; echo >> "$FAKE_LOG"`;

const FAKES = {
  git: `#!/bin/sh\n${LOG_CALL}\n`,

  // FAKE_PR=1: the branch has a PR. FAKE_LABELS: its labels, one per line.
  // FAKE_FAIL: fail any call whose arguments contain this text.
  gh: `#!/bin/sh
${LOG_CALL}
case " $* " in *"$FAKE_FAIL"*) [ -n "$FAKE_FAIL" ] && { echo "gh: $FAKE_FAIL failed" >&2; exit 1; } ;; esac
case "$*" in
  "pr view "*" --json labels "*) printf '%s\\n' "$FAKE_LABELS" ;;
  "pr view "*" --json url "*) echo "https://github.com/o/r/pull/7" ;;
  "pr view "*) [ "$FAKE_PR" = 1 ] || exit 1 ;;
esac
`,

  // FAKE_PR: the id of the branch's active PR, or empty.
  // FAKE_LABELS: its labels, one per line. Logs the body of a POST.
  az: `#!/bin/sh
${LOG_CALL}
case "$*" in
  "repos pr list "*) [ -z "$FAKE_PR" ] || echo "$FAKE_PR" ;;
  "repos pr create "*) echo 42 ;;
  *"--query labels[].name"*) printf '%s\\n' "$FAKE_LABELS" ;;
  *"--query repository.project.id"*) echo proj-id ;;
  *"--query repository.id"*) echo repo-id ;;
  *"--query join("*) echo "https://dev.azure.com/o/p/_git/r/pullrequest/42" ;;
  "devops invoke "*"--http-method POST"*)
    while [ $# -gt 0 ]; do [ "$1" = --in-file ] && cat "$2" >> "$FAKE_LOG" && echo >> "$FAKE_LOG"; shift; done ;;
esac
`,
};

beforeEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(BIN, { recursive: true });
  mkdirSync(WORKTREE);
  for (const [name, source] of Object.entries(FAKES)) {
    writeFileSync(join(BIN, name), source);
    chmodSync(join(BIN, name), 0o755);
  }
  writeFileSync(BODY, "> **Auto-merge: no human review needed**\n\n## Summary\n\n- done\n");
});

// Runs `sh <host>/pull-request.sh` like approver complete does.
function run(host, outcome, fake = {}) {
  const env = {
    PATH: `${BIN}:${process.env.PATH}`,
    FAKE_LOG: LOG,
    FAKE_PR: "",
    FAKE_LABELS: "",
    FAKE_FAIL: "",
    ...fake,
    FACTORY_ID: "001",
    FACTORY_TITLE: `Fix "quotes" & $(touch pwned)`,
    FACTORY_BRANCH: "factory/001",
    FACTORY_BASE: "main",
    FACTORY_WORKTREE: WORKTREE,
    FACTORY_OUTCOME: outcome,
    FACTORY_BODY_FILE: BODY,
    FACTORY_SCRIPTS: SCRIPTS,
  };
  const { status, stdout, stderr } = spawnSync("sh", [join(SCRIPTS, host, "pull-request.sh")],
    { cwd: WORKTREE, env, encoding: "utf8" });
  const calls = existsSync(LOG) ? readFileSync(LOG, "utf8").trimEnd().split("\n") : [];
  return { code: status, stdout, stderr, calls };
}

const TITLE = `[Fix "quotes" & $(touch pwned)]`;

describe("github/pull-request.sh", () => {
  test("APPROVE with no PR: pushes, creates the label and the PR, and turns on auto-merge", () => {
    const { code, stdout, calls } = run("github", "APPROVE");
    assert.equal(code, 0);
    assert.equal(stdout, "https://github.com/o/r/pull/7\n");
    assert.deepEqual(calls, [
      "git [push] [-u] [origin] [factory/001]",
      "gh [label] [create] [auto-merge] [--force] [--color] [0E8A16] [--description] [The factory approved this PR to merge without human review]",
      "gh [pr] [view] [factory/001]",
      `gh [pr] [create] [--base] [main] [--head] [factory/001] [--title] ${TITLE} [--body-file] [${BODY}] [--label] [auto-merge]`,
      "gh [pr] [merge] [factory/001] [--auto] [--squash]",
      "gh [pr] [view] [factory/001] [--json] [url] [-q] [.url]",
    ]);
    // The title is passed as data, never run.
    assert.ok(!existsSync(join(WORKTREE, "pwned")));
  });

  test("ESCALATE with no PR: labels it needs-human-review and doesn't merge", () => {
    const { code, calls } = run("github", "ESCALATE");
    assert.equal(code, 0);
    assert.match(calls[1], /^gh \[label\] \[create\] \[needs-human-review\] \[--force\] \[--color\] \[D93F0B\]/);
    assert.match(calls[3], /\[--label\] \[needs-human-review\]$/);
    assert.ok(!calls.some((call) => call.includes("[merge]")));
  });

  test("APPROVE after an ESCALATE updates the PR and swaps the label", () => {
    const { code, calls } = run("github", "APPROVE", { FAKE_PR: "1", FAKE_LABELS: "bug\nneeds-human-review" });
    assert.equal(code, 0);
    assert.deepEqual(calls.slice(3, 6), [
      `gh [pr] [edit] [factory/001] [--title] ${TITLE} [--body-file] [${BODY}] [--add-label] [auto-merge]`,
      "gh [pr] [view] [factory/001] [--json] [labels] [-q] [.labels[].name]",
      "gh [pr] [edit] [factory/001] [--remove-label] [needs-human-review]",
    ]);
    assert.ok(!calls.some((call) => call.includes("[create] [--base]")));
    assert.ok(calls.includes("gh [pr] [merge] [factory/001] [--auto] [--squash]"));
  });

  test("an existing PR without the other label keeps its labels", () => {
    const { code, calls } = run("github", "ESCALATE", { FAKE_PR: "1", FAKE_LABELS: "needs-human-review" });
    assert.equal(code, 0);
    assert.ok(!calls.some((call) => call.includes("--remove-label")));
  });

  test("stops at the first failing command", () => {
    const { code, stderr, calls } = run("github", "APPROVE", { FAKE_FAIL: "label create" });
    assert.equal(code, 1);
    assert.match(stderr, /gh: label create failed/);
    assert.equal(calls.length, 2);
  });

  test("rejects an unknown outcome before touching anything", () => {
    const { code, stderr, calls } = run("github", "PASS");
    assert.equal(code, 1);
    assert.equal(stderr, "unknown FACTORY_OUTCOME: PASS (expected APPROVE or ESCALATE)\n");
    assert.deepEqual(calls, []);
  });
});

describe("azure-devops/pull-request.sh", () => {
  test("APPROVE with no PR: pushes, creates the labelled PR and sets auto-complete", () => {
    const { code, stdout, calls } = run("azure-devops", "APPROVE");
    assert.equal(code, 0);
    assert.equal(stdout, "https://dev.azure.com/o/p/_git/r/pullrequest/42\n");
    assert.deepEqual(calls, [
      "git [push] [-u] [origin] [factory/001]",
      "az [repos] [pr] [list] [--source-branch] [factory/001] [--status] [active] [--query] [[0].pullRequestId] [-o] [tsv]",
      `az [repos] [pr] [create] [--source-branch] [factory/001] [--target-branch] [main] [--title] ${TITLE} ` +
        `[--description] [> **Auto-merge: no human review needed**\n\n## Summary\n\n- done] [--labels] [auto-merge] [--query] [pullRequestId] [-o] [tsv]`,
      "az [repos] [pr] [update] [--id] [42] [--auto-complete] [true] [--squash] [true] [--delete-source-branch] [true] [-o] [none]",
      "az [repos] [pr] [show] [--id] [42] [--query] [join('', [repository.webUrl, '/pullrequest/', to_string(pullRequestId)])] [-o] [tsv]",
    ].join("\n").split("\n"));
    assert.ok(!existsSync(join(WORKTREE, "pwned")));
  });

  test("ESCALATE with no PR: labels it needs-human-review and doesn't auto-complete", () => {
    const { code, calls } = run("azure-devops", "ESCALATE");
    assert.equal(code, 0);
    assert.ok(calls.some((call) => call.includes("[--labels] [needs-human-review]")));
    assert.ok(!calls.some((call) => call.includes("--auto-complete")));
  });

  test("APPROVE after an ESCALATE updates the PR and swaps the label through the REST API", () => {
    const { code, calls } = run("azure-devops", "APPROVE", { FAKE_PR: "9", FAKE_LABELS: "needs-human-review" });
    assert.equal(code, 0);
    const route = "[project=proj-id] [repositoryId=repo-id] [pullRequestId=9]";
    assert.ok(!calls.some((call) => call.includes("[create]")));
    assert.ok(calls.includes(`az [repos] [pr] [update] [--id] [9] [--title] ${TITLE} [--description] [> **Auto-merge: no human review needed**`));
    assert.ok(calls.some((call) => /^az \[devops\] \[invoke\] .*\[--http-method\] \[POST\] .*/.test(call) && call.includes(route)));
    assert.ok(calls.includes('{"name": "auto-merge"}'));
    assert.ok(calls.some((call) => call.includes("[--http-method] [DELETE]") && call.includes(`${route} [labelIdOrName=needs-human-review]`)));
    assert.ok(calls.includes("az [repos] [pr] [update] [--id] [9] [--auto-complete] [true] [--squash] [true] [--delete-source-branch] [true] [-o] [none]"));
  });

  test("an existing PR that already has the label isn't relabelled", () => {
    const { code, calls } = run("azure-devops", "ESCALATE", { FAKE_PR: "9", FAKE_LABELS: "needs-human-review" });
    assert.equal(code, 0);
    assert.ok(!calls.some((call) => call.includes("[invoke]")));
  });

  test("a description over 4000 characters is cut, with a note, on a character boundary", () => {
    writeFileSync(BODY, "é".repeat(3000));
    const { code, calls } = run("azure-devops", "ESCALATE");
    assert.equal(code, 0);
    const description = calls.join("\n").match(/\[--description\] \[([\s\S]*?)\] \[--labels\]/)[1];
    assert.ok(Buffer.byteLength(description) <= 4000);
    assert.match(description, /^é+\n\n_Cut to fit Azure DevOps' 4000 character limit\. The full decision is in the factory job folder\._$/);
  });

  test("rejects an unknown outcome before touching anything", () => {
    const { code, stderr, calls } = run("azure-devops", "PASS");
    assert.equal(code, 1);
    assert.equal(stderr, "unknown FACTORY_OUTCOME: PASS (expected APPROVE or ESCALATE)\n");
    assert.deepEqual(calls, []);
  });
});
