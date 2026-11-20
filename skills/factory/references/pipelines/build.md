# Build Pipeline

This pipeline is used to build new features or edit existing ones.
Each step below runs when the previous agent or script finishes.
Each step corresponds to an agent definition in `agents/` folder so make sure to spawn them with that file

Only run `<job.js> help` if you get stuck and need help with the script.

## File structure

```
<factory>/jobs/<job-id>/job.md                     contains the user's prompt that started the job and other relevant info about the job
<factory>/jobs/<job-id>/intake.md                  intake's decision, scope, risk, surfaces
<factory>/jobs/<job-id>/spec.md                    the spec written by the spec writer agent
<factory>/jobs/<job-id>/round-<N>/build.md         the builder's report for round N
<factory>/jobs/<job-id>/round-<N>/gate.md          the gate results for round N
<factory>/jobs/<job-id>/round-<N>/review-code.md   code reviewer's comments for round N
<factory>/jobs/<job-id>/round-<N>/review-security.md security reviewer's comments for round N
<factory>/jobs/<job-id>/round-<N>/feedback.md      the user's feedback on an escalated job in round N
<factory>/jobs/<job-id>/decision.md
<repo>/.worktrees/<job-id>/                    the job's worktree, on factory/<job-id>
```

## 0. Create Job

- Run `<job.js> create --prompt "<user_prompt>"` and remember it's job id in your context for later steps.

## 1. Intake

- Spawn `<agents>/intake.md` as a subagent with `<header>`
- Run `<job.js> intake <id> info` and read it's decision and do the following based on it's status:
  - **ACCEPT**: Go to step **Spec**.
  - **NEEDS-INFO**: The job parks until the author replies.
  - **REJECT**: The job is rejected

## 2. Spec

- Spawn `<agents>/spec-writer.md` agent with `<header>`. When it returns go to **Build**.

## 3. Build

- Spawn `<agents>/builder.md` agent with `<header> Build round <N>.`. When it returns, call `<job.js> builder <id> info --round <N>` and do the following based on the status:
  - `OUTCOME: READY`: Go to **Gate**.
  - `OUTCOME: BLOCKED`: This has been escalated to a human.

## 4. Gate

- Run `<job.js> gate <id> check --round <N>`. When it returns, call `<job.js> gate <id> info --round <N>`. Its `OUTCOME` is `PASS` or `FAIL`.
  - PASS: Go to **Review**.
  - FAIL: Retry build step for the next round. No reviewer runs on a failing build.

## 5. Review

- Run `<job.js> intake <id> info` to find which reviewers are needed for this job
- Spawn every reviewer as a subagent with `<header>`, so they run in parallel: `reviewer-<r>.md` launched with the model defined in `<factory>/config.json` with prompt `<header> Review round <N>.` plus the port for `ux` and
  `ui`. **WAIT FOR ALL agents to finish before moving onto the next step.**
- Run `<job.js> reviewer <id> info --round <N> --reviewer ALL` to get the verdicts of all the reviewers
- If all PASS then go to **Approver**
- If any CHANGES are needed, go back to the build step.

## 6. Approver

- Spawn `<agents>/approver.md` with `<header>`
- Run `<job.js> complete` to complete the job
