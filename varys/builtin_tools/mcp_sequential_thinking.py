"""MCP Sequential Thinking tool — Python-native implementation.

Mirrors the tool schema from the official MCP Sequential Thinking server
(https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking)
so the LLM sees exactly the same interface, but without any Node.js dependency.

The tool is injected into the agentic thought-loop in AnthropicProvider and
is NOT registered in the standard Varys tool registry (it is only used
internally to drive the multi-turn reasoning loop).
"""

SEQUENTIAL_THINKING_TOOL = {
    "name": "sequential_thinking",
    "description": (
        "A tool for dynamic and reflective problem-solving through thoughts.\n"
        "Use this to think through problems step by step before providing a final answer.\n\n"
        "Guidelines:\n"
        "- Break complex problems into numbered thought steps\n"
        "- Each thought should build on, question, or revise previous insights\n"
        "- Freely revise earlier thoughts when new understanding emerges "
        "(set isRevision=true and revisesThought=N)\n"
        "- Branch into alternative approaches when useful "
        "(set branchFromThought=N, branchId='branch-name')\n"
        "- Adjust totalThoughts up or down as you go — it is an estimate, not a limit\n"
        "- Set nextThoughtNeeded=false ONLY when you have fully reasoned through the problem"
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "thought": {
                "type": "string",
                "description": "Your current thinking step",
            },
            "nextThoughtNeeded": {
                "type": "boolean",
                "description": (
                    "True if more thinking is needed. "
                    "Set to false only when reasoning is complete."
                ),
            },
            "thoughtNumber": {
                "type": "integer",
                "description": "Current thought number (1-based)",
                "minimum": 1,
            },
            "totalThoughts": {
                "type": "integer",
                "description": "Current estimate of total thoughts needed (can be revised)",
                "minimum": 1,
            },
            "isRevision": {
                "type": "boolean",
                "description": "True if this thought revises a previous one",
            },
            "revisesThought": {
                "type": "integer",
                "description": "Which thought number is being reconsidered (requires isRevision=true)",
            },
            "branchFromThought": {
                "type": "integer",
                "description": "Thought number this branches from",
            },
            "branchId": {
                "type": "string",
                "description": "Identifier for this reasoning branch",
            },
            "needsMoreThoughts": {
                "type": "boolean",
                "description": "Set true when reaching the estimated end but realising more thinking is needed",
            },
        },
        "required": ["thought", "nextThoughtNeeded", "thoughtNumber", "totalThoughts"],
    },
}

# Maximum thought steps allowed per request (safety ceiling — LLM usually
# finishes far sooner).
MAX_THOUGHTS = 25
