---
name: pi-subagents
description: Spawn LLM subagents by running the `pi` CLI non-interactively from the shell. Use when a task should be delegated to a separate agent (parallel research, isolated reviews, second opinions, a different model), or when the user asks to "use a subagent", "delegate", or "ask another model".
---

# pi-subagents

Run a subagent as a one-shot shell command. It reads the prompt (plus any attached files), does its work, writes its final answer to **stdout**, and exits. Treat it like any other CLI tool: build the command, run it, read stdout, check the exit code.

## Command

Always use print mode with text output. Without `-p`, pi opens its interactive TUI and hangs.

```bash
pi -p --mode text --no-session [--model <model>] [@file ...] "<prompt>"
```

| Part | Purpose |
|---|---|
| `-p` | Non-interactive: run the prompt, print the final response, exit |
| `--mode text` | Plain-text output. Always use this mode |
| `--no-session` | Don't save the session to disk. Subagents are disposable |
| `--model <pattern>` | Optional. Model ID or fuzzy pattern, e.g. `sonnet`, `openai/gpt-4o`, `sonnet:high` (`:<thinking>` suffix sets the thinking level) |
| `@path` | Attach a text file or image to the prompt. Repeat for multiple files. Paths resolve from the current working directory |
| `"<prompt>"` | The task. Put it last. If it starts with `-`, put `--` before it |

The subagent runs in the current working directory and has the default tools (`read`, `bash`, `edit`, `write`). Run it from the directory it should work in.

## Choosing a model

If the user names a model, pass it with `--model`. If not, list the available models and choose one that fits the task (or ask the user):

```bash
pi --list-models            # all available models
pi --list-models sonnet     # fuzzy-filtered
```

Output is a table with `provider`, `model`, `context`, `max-out`, `thinking`, and `images` columns. Pass `provider/model` to `--model` to avoid ambiguity, e.g. `--model github-copilot/claude-sonnet-5`. If you omit `--model`, pi uses its configured default.

## Reading the result

- **stdout**: the subagent's final response. This is the only output you should use.
- **stderr**: errors and warnings. Read it only when the run fails.
- **exit code**:
  - `0`: success. stdout holds the complete answer.
  - nonzero: failure. The model errored, the run was aborted, or the response hit the output token limit. In the token-limit case stdout may contain partial text, so don't treat it as complete.

```bash
out=$(pi -p --mode text --no-session --model sonnet @src/auth.ts "Review this file for security bugs. List findings only.")
status=$?
if [ $status -ne 0 ]; then
  echo "subagent failed (exit $status)" >&2
fi
echo "$out"
```

## Examples

```bash
# Plain prompt
pi -p --mode text --no-session "Summarize what this repository does in 3 bullets."

# Multiple files + specific model
pi -p --mode text --no-session --model openai/gpt-4o @README.md @src/index.ts "Does the README match the code? List mismatches."

# Image input
pi -p --mode text --no-session @screenshot.png "Describe the UI bug shown here."

# Parallel subagents: run in the background, then wait
pi -p --mode text --no-session @a.ts "Review a.ts" > /tmp/review-a.txt &
pi -p --mode text --no-session @b.ts "Review b.ts" > /tmp/review-b.txt &
wait
```

## Writing subagent prompts

The subagent has none of your context. Each prompt must be self-contained:

- State the goal, the constraints, and the exact output format you want back.
- Attach the files it needs with `@path` instead of describing them.
- Say whether it may modify files. If it shouldn't, say so explicitly.
- Ask for a concise final answer, since all of stdout comes back to you.
