"""Azure OpenAI provider for the Varys File Agent.

Subclasses OpenAIAgentProvider — only the client construction differs.
"""
from __future__ import annotations

from .openai_provider import OpenAIAgentProvider


class AzureOpenAIAgentProvider(OpenAIAgentProvider):
    """Azure OpenAI provider.

    Uses openai.AsyncAzureOpenAI with the deployment name as model.
    All tool-calling logic is inherited from OpenAIAgentProvider.
    """

    def __init__(
        self,
        api_key: str,
        endpoint: str,
        api_version: str,
        deployment: str,
    ) -> None:
        import openai
        client = openai.AsyncAzureOpenAI(
            api_key=api_key,
            azure_endpoint=endpoint,
            api_version=api_version,
        )
        super().__init__(client=client, model=deployment)

    def _get_provider_name(self) -> str:
        return "azure"

    def _get_suggestion(self) -> str:
        return (
            "Check that your Azure deployment uses a chat model (gpt-4o, gpt-4.1) "
            "rather than an embedding or completions-only deployment."
        )
