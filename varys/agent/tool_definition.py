"""Provider-agnostic tool definition.

Each tool is described once here; the schema translation layer in
tool_schemas.py converts it to Anthropic, OpenAI, or Bedrock format.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ToolDefinition:
    """Provider-agnostic description of one callable tool.

    Parameters follows JSON Schema draft-07 object format:
    {"type": "object", "properties": {...}, "required": [...]}
    """
    name: str
    description: str
    parameters: dict
