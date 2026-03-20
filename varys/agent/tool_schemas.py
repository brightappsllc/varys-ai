"""Tool schema translation layer.

Converts a list of provider-agnostic ToolDefinition objects into the
native tool/function-call format for each provider.
"""
from __future__ import annotations

import json
from typing import Any

from .tool_definition import ToolDefinition


def to_anthropic_tools(defs: list[ToolDefinition]) -> list[dict]:
    """Convert to Anthropic tools format."""
    return [
        {
            "name": d.name,
            "description": d.description,
            "input_schema": d.parameters,
        }
        for d in defs
    ]


def to_openai_tools(defs: list[ToolDefinition]) -> list[dict]:
    """Convert to OpenAI / Azure / Ollama function-calling format."""
    return [
        {
            "type": "function",
            "function": {
                "name": d.name,
                "description": d.description,
                "parameters": d.parameters,
            },
        }
        for d in defs
    ]


def to_bedrock_tools(defs: list[ToolDefinition]) -> dict:
    """Convert to AWS Bedrock Converse API toolConfig format."""
    return {
        "tools": [
            {
                "toolSpec": {
                    "name": d.name,
                    "description": d.description,
                    "inputSchema": {"json": d.parameters},
                }
            }
            for d in defs
        ]
    }


def parse_tool_input(raw_input: Any) -> dict:
    """Parse a tool input value into a plain dict.

    Anthropic and Bedrock return dicts directly.
    OpenAI and Ollama return a JSON string in delta.tool_calls[*].function.arguments.
    """
    if isinstance(raw_input, str):
        return json.loads(raw_input)
    if isinstance(raw_input, dict):
        return raw_input
    raise ValueError(f"Unexpected tool input type: {type(raw_input)}")
