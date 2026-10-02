---
name: brainstorm
description: Brainstorm solutions to a problem by first clarifying the problem through targeted questions, then generating multiple solution options with pros and cons. Use when user wants to brainstorm, explore solutions, weigh options, or says "brainstorm", "what are my options", "help me think through this".
---

# Brainstorm

Help the user arrive at a well-considered solution by first deeply understanding the problem, then generating and evaluating options.

## Phase 1 — Clarify the problem

Before generating any solutions, make sure you fully understand the problem.

1. Read any files, context, or links the user has provided.
2. Restate the problem in one sentence and ask the user to confirm or correct.
3. If the problem is ambiguous or underspecified, interview the user one question at a time until you can answer all of:
   - **What** is the concrete outcome they need?
   - **Who** is affected and what are their constraints?
   - **Why** do current approaches fall short?
   - **Where** are the boundaries — what is in scope and out of scope?
4. Summarize your understanding in a short "Problem Statement" block and get explicit confirmation before moving on.

Do not skip to solutions early. If the user tries to jump ahead, gently redirect: "Let me make sure I understand the problem fully first — it'll make the options much stronger."

## Phase 2 — Generate options

Once the problem is confirmed:

1. Brainstorm **3–5 distinct solution options**. Aim for genuine variety — different approaches, not minor variations of the same idea.
2. Present each option as its own markdown section:
   <option>
      ### Option N: {Short memorable name}

   **How it works** — 2–4 sentence description.

   **Pros**
   - concrete advantage 1
   - concrete advantage 2

   **Cons**
   - concrete disadvantage, risk, or trade-off 1
   - concrete disadvantage, risk, or trade-off 2

   **Effort** — low / medium / high with a brief justification.
   </option>

3. The output should read like a clean markdown document — no tables, no side-by-side layouts.

## Phase 3 — Narrow and refine

After presenting options:

1. Ask the user which options resonate and why.
2. Offer to combine strengths from multiple options if applicable.
3. Deep-dive on the top 1–2 options with implementation details, next steps, or a rough plan.
4. If the user is stuck choosing, ask targeted tie-breaker questions (e.g., "What matters more — speed to ship or long-term flexibility?").

## Guidelines

- Ask questions one at a time during the interview phase.
- If a question can be answered by exploring the codebase or provided context, do that instead of asking the user.
- Keep options concrete and actionable, not theoretical.
- Be honest about trade-offs — don't oversell any option.
- Match the depth of analysis to the scale of the problem (don't over-engineer small decisions).
