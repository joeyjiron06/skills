---
name: factory
description: Run the software factory on user defined tasks. Use when the user types /factory run, /factory run <n>, or /factory followed by anything else (a question, feedback on a job, or a new feature). The session that runs it becomes the one orchestrator for every job.
---

# Factory

You are the factory's only orchestrator. You work through user defined tasks/prompts,
run up to `concurrency` jobs at once, and spawn every agent for every
job. You never write code, specs, reviews or decisions yourself, and you never
edit any files directly yourself: the scripts in `scripts/` change state and refuse illegal
moves. When a script refuses, its message says why. Fix the cause or stop and
tell the user; never work around it.

```
/factory build <prompt>   build a new feature or edit an existing one
/factory fix <issue>      fix a bug
/factory <anything>       talk to the factory: ask about jobs, give feedback, file a feature
```

## File References

File references are relative to this current markdown file, e.g. scripts/job.js is located in a sibling folder to this file.
Here are some definitions to folders referenced in the docs below.

- `<repo>` - the root repo, no work should be done here, all work should be done in worktree
- `<worktree>` - located in `<repo>/.worktrees/<job_id>` which is a worktree for a specific job
- `<factory>` - either `<repo>/<agent_harness>/skills/factory/` where `<agent_harness>` is one of: `.agents`, `.claude`, `.cursor`, `.github`, `.copilot` or other similar dot folder for where agents install skills
- `<agents>` - alias for `<factory>/agents/`
- `<jobs>` - alias for `<factory>/jobs/` where all the jobs live. each folder is a job id that is an incrementing 3 digit number
- `<job folder>` - alias for `<factory>/jobs/<id>` where a specific job lives
- `<scripts>` - alias for `<factory>/scripts/`
- `<job.js>` - alias for `node <scripts>/job.js`

## Config

`config.json` sets up the factory for this repo:

- `concurrency`, `max_rounds`: how many jobs run at once, and how many build rounds a job gets.
- `base_branch`: the branch jobs start from and pull requests target.
- `agents`: the model for each agent.
- `gate`: shell commands that must all pass after every build (tests, lint, typecheck, build).
- `pull_request.APPROVE` and `pull_request.ESCALATE`: shell commands `approver complete` runs in the job's worktree to open the pull request. Set a list to `[]` to open no PR. See [Pull requests](#pull-requests).

## Pull requests

When the approver finishes, `approver complete` opens a pull request for the job, whatever the decision:

- **APPROVE**: labelled `auto-merge`, and set to merge on its own once the host's checks pass.
- **ESCALATE**: labelled `needs-human-review`.

The PR's title is the job's title (`job create --title`) and its description is the approver's decision. Running it again updates the same PR instead of opening a second one.

`scripts/` has a ready-made script for each host. Point both `config.json -> pull_request` lists at the one for yours:

| Host | Script | Needs |
|---|---|---|
| GitHub (default) | `scripts/github/pull-request.sh` | `gh`, logged in. Auto-merge needs "Allow auto-merge" on in the repo settings. |
| Azure DevOps | `scripts/azure-devops/pull-request.sh` | `az` with the `azure-devops` extension, logged in. Auto-merge is Azure DevOps' auto-complete. Descriptions over 4000 characters are cut. |

For Azure DevOps:

```json
"pull_request": {
  "APPROVE": ["sh \"$FACTORY_SCRIPTS/azure-devops/pull-request.sh\""],
  "ESCALATE": ["sh \"$FACTORY_SCRIPTS/azure-devops/pull-request.sh\""]
}
```

For any other host, write your own commands or script. They run in order in the job's worktree, stop at the first failure (logged in `<job folder>/pr.md`), and can read `$FACTORY_ID`, `$FACTORY_TITLE`, `$FACTORY_BRANCH`, `$FACTORY_BASE`, `$FACTORY_WORKTREE`, `$FACTORY_OUTCOME`, `$FACTORY_BODY_FILE` and `$FACTORY_SCRIPTS` (details in `<job.js> help`). Always quote them: the title comes from a user prompt.

## Spawning agents

Spawn every agent as a subagent in the background. Start the subagent with model
defined in `config.json -> agents` and use the relevant `references/agents/<agent>.md` file in the prompt.
Each agent writes it's own markdown file with frontmatter. Use the step's info command to read its frontmatter, e.g. `<job.js> intake info --id <id>` or `<job.js> builder info --id <id> --round <N>`.

Every agent file uses the same frontmatter fields:

- `STATUS: RUNNING | COMPLETE`: the agent writes `RUNNING` first thing, then `COMPLETE` when it's done.
- `STARTED: <ISO 8601 UTC>`: when the agent started.
- `FINISHED: <ISO 8601 UTC>`: when the agent finished; only once `COMPLETE`.
- `OUTCOME: <value>`: the agent's result, once `COMPLETE`. Values depend on the agent (e.g. `ACCEPT`, `READY`, `PASS`, `APPROVE`); spec.md has none.

Only act on an `OUTCOME` when `STATUS: COMPLETE`. If an agent has returned and its file still says `STATUS: RUNNING`, the agent crashed or stopped early: don't trust the file, tell the user.
While agents run, don't poll and don't wait: end your turn with a one-line status.

Every prompt for the spawned agent starts with the job's header:

```
Job: <id>. Job folder: <factory>/jobs/<id>/. Main checkout: <repo>. Worktree: <worktree>. Branch: <branch>. Base: origin/<base>. Agent: <agents>/<agent>.md.
```

`<header>` below means that line.

## `/factory build <prompt>`

Read and run the pipeline defined in `references/pipelines/build.md`

## `/factory fix <prompt>`

Read and run the pipeline defined in `references/pipelines/fix.md`
