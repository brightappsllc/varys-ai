# Varys Persona Skill

## What it does

Injects a persistent identity and expertise layer into every LLM request.
It shapes Varys's communication style, statistical rigour standards, Python
engineering best practices, and business-impact framing — without changing
what you ask or what the model does.

## Tier

**Tier 1 — always loaded.** Because this skill declares no `command:` and
no `keywords:`, it is injected on every single chat and agent request.
Think of it as a permanent system-level addendum that runs alongside the
built-in Varys system prompt.

## What it covers

| Section | Effect |
|---|---|
| Communication style | Collegial, direct, lead with the key insight |
| Statistical rigour | Flags sample size issues, multiple testing, correlation ≠ causation |
| Python best practices | Type hints, docstrings, idiomatic pandas, vectorised ops |
| ML / Time series / A/B | Domain-specific guardrails per analysis type |
| Business impact framing | Connects findings to decisions and risk |
| Uncertainty | Encourages honest "the data doesn't support X" answers |

## Token cost

Approximately 500–550 tokens per request (the full SKILL.md content).
This is added to every message, so on a busy session it accumulates.
If you find Varys's responses feel overly hedged or verbose, disabling
this skill is a good first thing to try.

## How to disable

Open **Settings → Skills** in the Varys sidebar and toggle the
`varys` skill off. The change takes effect on the next message.
Re-enable at any time; the skill file is never deleted by the toggle.

## Notes

- The content complements (not replaces) the built-in Varys system prompt.
- Editing `SKILL.md` here and hitting Refresh in the Skills panel takes
  effect immediately — no server restart needed.
- This skill intentionally has no slash command. It is not invoked
  explicitly; it is always present.
