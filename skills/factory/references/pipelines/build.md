# Build Pipeline

This pipeline is used to build new features or edit existing ones.
Each step below runs when the previous agent or script finishes.
Each step corresponds to an agent definition in the `<agents>` folder (`references/agents/`) so make sure to spawn them with that file

Only run `<job.js> help` if you get stuck and need help with the script.

## File structure

```
<factory>/jobs/<job-id>/job.md                     contains the user's prompt that started the job and other relevant info about the job
<factory>/jobs/<job-id>/intake.md                  intake's decision, scope, risk, surfaces, with any author feedback on a BLOCKED intake and the decisions after it
<factory>/jobs/<job-id>/spec.md                    the spec written by the spec writer agent
<factory>/jobs/<job-id>/round-<N>/build.md         the builder's report for round N, with any user feedback on a BLOCKED build and the reports after it
<factory>/jobs/<job-id>/round-<N>/gate.md          the gate results for round N
<factory>/jobs/<job-id>/round-<N>/review-code.md   code reviewer's comments for round N
<factory>/jobs/<job-id>/round-<N>/review-security.md security reviewer's comments for round N
<factory>/jobs/<job-id>/round-<N>/review-ui.md     UI reviewer's comments on visual design consistency for round N (only when intake requests the ui reviewer)
<factory>/jobs/<job-id>/round-<N>/review-ux.md     UX reviewer's comments on flows, states, copy and accessibility for round N (only when intake requests the ux reviewer)
<factory>/jobs/<job-id>/decision.md
<factory>/jobs/<job-id>/pr.md                      the logs of the commands that opened the pull request
<repo>/.worktrees/<job-id>-<slug>/             the job's worktree, on factory/<job-id>-<slug> (see job.md)
```

## 0. Create Job

- Write a short title for the job: one line, in the imperative, under ~70 characters (e.g. "Add a dark mode toggle to settings"). It becomes the pull request title.
- Run `<job.js> create --title "<title>" --prompt "<user_prompt>"` and remember it's job id in your context for later steps.

## 1. Intake

- Spawn `<agents>/intake.md` as a subagent with `<header>` (`<header> Resuming after the author's feedback.` after **Intake feedback**)
- Run `<job.js> intake info --id <id>` and read it's decision and do the following based on it's status:
  - **ACCEPT**: Go to step **Spec**.
  - **BLOCKED**: intake needs answers only the author can give. Tell the user its questions (the latest `## Questions` section of `intake.md`) and wait for their reply: see **Intake feedback**.
  - **REJECT**: The job is rejected

## 2. Spec

- Spawn `<agents>/spec-writer.md` agent with `<header>`. When it returns go to **Build**.

## 3. Build

- A job gets at most `config.json -> max_rounds` rounds. When round `<N>` would be over it, don't start it: go to **Approver**, which marks the job `BLOCKED`. (`builder start` refuses that round anyway.)
- Spawn `<agents>/builder.md` agent with `<header> Build round <N>.` (`<header> Build round <N>, resuming after the user's feedback.` after **Build feedback**). When it returns, call `<job.js> builder info --id <id> --round <N>` and do the following based on the status:
  - `OUTCOME: READY`: Go to **Gate**.
  - `OUTCOME: BLOCKED`: the builder needs a human. Tell the user what blocks it (the latest `## Blocked` section of `round-<N>/build.md`) and wait for their reply: see **Build feedback**.

## 4. Gate

- Run `<job.js> gate check --id <id> --round <N>`. When it returns, call `<job.js> gate info --id <id> --round <N>`. Its `OUTCOME` is `PASS` or `FAIL`.
  - PASS: Go to **Review**.
  - FAIL: Go back to **Build** for round `<N+1>`. No reviewer runs on a failing build.

## 5. Review

- Run `<job.js> intake info --id <id>` to find which reviewers are needed for this job
- Spawn every reviewer as a subagent with `<header>`, so they run in parallel: `reviewer-<r>.md` launched with the model defined in `<factory>/config.json` with prompt `<header> Review round <N>.` plus the port for `ux` and
  `ui`. **WAIT FOR ALL agents to finish before moving onto the next step.**
- Run `<job.js> reviewer info --id <id> --round <N> --reviewer ALL` to get the verdicts of all the reviewers
- If all PASS then go to **Approver**
- If any CHANGES are needed, go back to **Build** for round `<N+1>`.

## 6. Approver

- The approver decides on the latest round. `approver start` checks it: the build is `READY`, the gate `PASS` and every review `PASS`.
  - All pass (`CHECKS: PASS`): the approver chooses `APPROVE` or `APPROVAL-NEEDS-HUMAN`. Both open a pull request.
  - Any fail (`CHECKS: FAIL`): the approver can only decide `BLOCKED`, with the reasons. It opens no pull request. `approver start` only allows this when no round is left to fix it: the build was `BLOCKED` or this is the last round `max_rounds` allows.
- Spawn `<agents>/approver.md` with `<header>`. When it returns, call `<job.js> approver info --id <id>`. Its `OUTCOME` is `APPROVE`, `APPROVAL-NEEDS-HUMAN` or `BLOCKED`.
- For `APPROVE` and `APPROVAL-NEEDS-HUMAN`, `approver complete` opened the pull request on GitHub or Azure DevOps by running `config.json -> pull_request.<OUTCOME>` (see Pull requests in `SKILL.md`), and logged it to `<job folder>/pr.md`; the PR's URL is the last log line. Give the user the link:
  - **APPROVE**: the PR is labelled `auto-merge` and set to merge on its own. Tell the user the PR is in.
  - **APPROVAL-NEEDS-HUMAN**: the PR is labelled `needs-human-review`. Tell the user what the approver needs from them (the `For the human` section of `decision.md`).
  - If `decision.md` is still `RUNNING` and `pr.md` says `OUTCOME: FAIL`, the pull request failed: tell the user which command failed and why.
- **BLOCKED**: no pull request. Tell the user the job needs them, why the factory couldn't finish it (each failed check), and what's left to do: the `For the human` section of `decision.md`. Point them at the branch and worktree in `job.md`.
- The decision is final: the job never goes back to **Build**.

## 7. Complete

- As the very last step, once the approver's pull request opened (`APPROVE` or `APPROVAL-NEEDS-HUMAN`), run `<job.js> complete --id <id>`. It records `FINISHED` in `job.md`, marking the whole job done.
- Never run it for a `BLOCKED` decision: the job stays open, waiting on a human.

## Intake feedback

When the user replies to a job whose intake is `OUTCOME: BLOCKED`:

- Assume they are answering intake's questions so the job can carry on, unless they say otherwise (e.g. "stop", "drop it").
- **Carry on**: write the user's reply, word for word, to a temporary file outside the job folder, then run `<job.js> intake feedback --id <id> --content <file-path>`. It appends the reply to `intake.md` under `# User feedback <n>`, sets it back to `STATUS: RUNNING` with a `FEEDBACK: <n>` count, and deletes the temporary file. Then go back to **Intake**: the intake decides again, and its new decision is appended below the feedback.
- **Stop**: leave the job parked at `BLOCKED`; nothing else runs.

## Build feedback

When the user replies to a job whose latest round's build is `OUTCOME: BLOCKED`:

- Assume they want the build to carry on, unless they say otherwise (e.g. "stop", "drop it", "I'll take it from here").
- **Carry on**: write the user's reply, word for word, to a temporary file outside the job folder, then run `<job.js> builder feedback --id <id> --round <N> --content <file-path>`. It appends the reply to `round-<N>/build.md` under `# User feedback <n>`, sets it back to `STATUS: RUNNING` with a `FEEDBACK: <n>` count, and deletes the temporary file. Then go back to **Build** for the same round `<N>`: the round number doesn't change, and the builder's next report is appended below the feedback.
- **Stop**: go to **Approver**, which marks the job `BLOCKED` with no pull request.
