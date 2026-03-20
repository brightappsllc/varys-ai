"""AWS Bedrock provider for the Varys File Agent.

Uses the Bedrock Converse API (converse_stream) via boto3.
The synchronous boto3 call is wrapped in asyncio.to_thread() so the
agentic loop remains fully async without introducing aioboto3.
"""
from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator

from ..provider_base import (
    AgentProvider,
    AgentTurnEvent,
    TextDelta,
    ToolCall,
    TurnEnd,
    ToolUseNotSupportedError,
)
from ..tool_definition import ToolDefinition
from ..tool_schemas import to_bedrock_tools, parse_tool_input

log = logging.getLogger(__name__)


class BedrockAgentProvider(AgentProvider):
    """AWS Bedrock Converse API provider.

    Credentials are read from the constructor arguments or fall through to
    standard boto3 credential resolution (env vars, ~/.aws/credentials, IAM role).
    """

    def __init__(
        self,
        region: str,
        model_id: str,
        aws_access_key: str | None = None,
        aws_secret_key: str | None = None,
        aws_session_token: str | None = None,
    ) -> None:
        import boto3
        kwargs: dict = {"region_name": region}
        if aws_access_key:
            kwargs["aws_access_key_id"] = aws_access_key
        if aws_secret_key:
            kwargs["aws_secret_access_key"] = aws_secret_key
        if aws_session_token:
            kwargs["aws_session_token"] = aws_session_token
        self._client = boto3.client("bedrock-runtime", **kwargs)
        self._model_id = model_id
        self.last_usage: dict = {"input": 0, "output": 0}

    def make_initial_messages(self, task: str) -> list[dict]:
        """Bedrock Converse API requires content as a list of blocks."""
        return [{"role": "user", "content": [{"text": task}]}]

    async def stream_turn(  # type: ignore[override]
        self,
        messages: list[dict],
        tool_definitions: list[ToolDefinition],
        system_prompt: str,
        max_tokens: int,
        require_tool_use: bool = False,
    ) -> AsyncIterator[AgentTurnEvent]:
        def _run_sync() -> list[AgentTurnEvent]:
            response = self._client.converse_stream(
                modelId=self._model_id,
                system=[{"text": system_prompt}],
                messages=messages,
                toolConfig=to_bedrock_tools(tool_definitions),
                inferenceConfig={"maxTokens": max_tokens},
            )

            events: list[AgentTurnEvent] = []
            tool_input_buffers: dict[str, str] = {}
            current_tool_id: str | None = None
            current_tool_name: str | None = None

            for chunk in response["stream"]:
                if "contentBlockStart" in chunk:
                    block = chunk["contentBlockStart"].get("start", {})
                    if "toolUse" in block:
                        current_tool_id = block["toolUse"]["toolUseId"]
                        current_tool_name = block["toolUse"]["name"]
                        tool_input_buffers[current_tool_id] = ""

                elif "contentBlockDelta" in chunk:
                    delta = chunk["contentBlockDelta"]["delta"]
                    if "text" in delta:
                        events.append(TextDelta(text=delta["text"]))
                    elif "toolUse" in delta and current_tool_id:
                        tool_input_buffers[current_tool_id] += delta["toolUse"].get("input", "")

                elif "contentBlockStop" in chunk:
                    if current_tool_id and current_tool_id in tool_input_buffers:
                        try:
                            parsed_input = parse_tool_input(tool_input_buffers[current_tool_id])
                        except Exception:
                            parsed_input = {}
                        events.append(ToolCall(
                            call_id=current_tool_id,
                            tool_name=current_tool_name or "",
                            tool_input=parsed_input,
                        ))
                        current_tool_id = None
                        current_tool_name = None

                elif "messageStop" in chunk:
                    stop_reason = chunk["messageStop"]["stopReason"]
                    if stop_reason == "tool_use":
                        events.append(TurnEnd(stop_reason="tool_use"))
                    else:
                        events.append(TurnEnd(stop_reason="end_turn"))

                elif "metadata" in chunk:
                    _u = chunk["metadata"].get("usage", {})
                    self.last_usage = {
                        "input":  _u.get("inputTokens",  0) or 0,
                        "output": _u.get("outputTokens", 0) or 0,
                    }

            return events

        try:
            collected = await asyncio.to_thread(_run_sync)
        except Exception as exc:
            log.error("BedrockAgentProvider error: %s", exc)
            yield TurnEnd(stop_reason="error", error_message=str(exc))
            return

        has_tool_calls = any(isinstance(e, ToolCall) for e in collected)
        if require_tool_use and not has_tool_calls:
            raise ToolUseNotSupportedError(
                provider="bedrock",
                model=self._model_id,
                reason="Model returned no tool calls despite tool definitions being present.",
                suggestion=(
                    "This Bedrock model does not support tool calling via the Converse API. "
                    "Use a Claude model (e.g. anthropic.claude-3-5-sonnet-20241022-v2:0) "
                    "or another Converse-compatible model."
                ),
            )

        for event in collected:
            yield event

    def build_assistant_history_message(
        self,
        text_content: str,
        tool_calls: list[ToolCall],
    ) -> dict:
        content: list[dict] = []
        if text_content:
            content.append({"text": text_content})
        for tc in tool_calls:
            content.append({
                "toolUse": {
                    "toolUseId": tc.call_id,
                    "name": tc.tool_name,
                    "input": tc.tool_input,
                }
            })
        return {"role": "assistant", "content": content}

    def build_tool_result_message(
        self,
        tool_calls: list[ToolCall],
        results: list[str],
    ) -> dict:
        return {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": tc.call_id,
                        "content": [{"text": result}],
                    }
                }
                for tc, result in zip(tool_calls, results)
            ],
        }
