"""ChromaDB wrapper for Varys RAG.

Uses cosine similarity with a persistent local database stored at:
    <notebook_dir>/.jupyter-assistant/rag/chroma/

Lazy initialisation: the ChromaDB client is created on first use, so importing
this module does not require chromadb to be installed.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

from ..utils.config import get_config as _get_cfg  # noqa: E402


def _collection_name() -> str:
    return _get_cfg().get("retrieval", "collection_name", "ds_assistant_knowledge")


def _distance_metric() -> str:
    return _get_cfg().get("retrieval", "distance_metric", "cosine")


class RAGStore:
    """Thin wrapper around a ChromaDB persistent collection."""

    def __init__(self, base_dir: "str | Path") -> None:
        """Args:
            base_dir: The .jupyter-assistant directory for this notebook.
                      Use ``nb_base(root_dir, notebook_path)`` to obtain it.
        """
        self._chroma_dir = Path(base_dir) / "rag" / "chroma"
        self._client: Optional[Any]     = None
        self._collection: Optional[Any] = None

    # ── Lifecycle ──────────────────────────────────────────────────────────

    def _ensure(self) -> None:
        """Lazy-initialise the ChromaDB client and collection."""
        if self._collection is not None:
            return
        import os
        import chromadb  # optional dep — ImportError surfaces here if missing

        # Disable chromadb's posthog analytics telemetry.  ChromaDB pulls in the
        # posthog package and sends anonymous usage data by default; opt out here
        # so Varys users are never surprised by unexpected outbound traffic.
        os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")

        self._chroma_dir.mkdir(parents=True, exist_ok=True)
        self._client = chromadb.PersistentClient(path=str(self._chroma_dir))
        self._collection = self._client.get_or_create_collection(
            name=_collection_name(),
            metadata={"hnsw:space": _distance_metric()},
        )
        log.info("RAGStore: opened ChromaDB at %s (%d chunks)",
                 self._chroma_dir, self._collection.count())

    # ── Write ──────────────────────────────────────────────────────────────

    def upsert(
        self,
        chunks: List[Dict[str, Any]],
        embeddings: List[List[float]],
    ) -> None:
        """Upsert chunks into the collection (insert-or-replace by id)."""
        self._ensure()
        if not chunks:
            return

        ids       = [_chunk_id(c, i) for i, c in enumerate(chunks)]
        texts     = [c["text"] for c in chunks]
        metadatas = [_safe_metadata(c) for c in chunks]

        self._collection.upsert(  # type: ignore[union-attr]
            ids=ids,
            embeddings=embeddings,
            documents=texts,
            metadatas=metadatas,
        )

    def delete_by_source(self, source_file: str) -> int:
        """Remove all chunks that came from *source_file*. Returns count removed."""
        self._ensure()
        try:
            existing = self._collection.get(  # type: ignore[union-attr]
                where={"source_file": source_file}
            )
            ids = existing.get("ids", [])
            if ids:
                self._collection.delete(ids=ids)  # type: ignore[union-attr]
            return len(ids)
        except Exception as exc:
            log.warning("RAGStore.delete_by_source failed: %s", exc)
            return 0

    # ── Read ───────────────────────────────────────────────────────────────

    def query(
        self,
        query_embedding: List[float],
        top_k: int = 5,
        source_filter: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Return the top-k nearest chunks for *query_embedding*."""
        self._ensure()
        kwargs: Dict[str, Any] = {
            "query_embeddings": [query_embedding],
            "n_results": min(top_k, max(1, self.count())),
            "include": ["documents", "metadatas", "distances"],
        }
        if source_filter:
            kwargs["where"] = {"source_file": source_filter}
        return self._collection.query(**kwargs)  # type: ignore[union-attr]

    def count(self) -> int:
        """Total number of chunks in the collection."""
        self._ensure()
        return self._collection.count()  # type: ignore[union-attr]

    def list_sources(self) -> List[str]:
        """Return the set of indexed source file paths."""
        self._ensure()
        try:
            result = self._collection.get(include=["metadatas"])  # type: ignore
            sources = {m.get("source_file", "") for m in result.get("metadatas", [])}
            return sorted(s for s in sources if s)
        except Exception:
            return []

    def reset(self) -> None:
        """Delete and recreate the collection (nuclear option)."""
        self._ensure()
        self._client.delete_collection(_COLLECTION_NAME)  # type: ignore[union-attr]
        self._collection = self._client.get_or_create_collection(  # type: ignore[union-attr]
            name=_COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
        log.info("RAGStore: collection reset")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _chunk_id(chunk: Dict[str, Any], fallback_idx: int) -> str:
    """Deterministic id for a chunk so upsert is idempotent."""
    src = str(chunk.get("source_file", "unknown"))
    ctype = chunk.get("chunk_type", "chunk")
    # Use cell_idx or page if available, otherwise fall back to content hash
    loc = chunk.get("cell_idx") if chunk.get("cell_idx") is not None else chunk.get("page")
    if loc is not None:
        return f"{src}::{ctype}::{loc}"
    # Hash the first 200 chars of text as a stable key
    import hashlib
    h = hashlib.md5(chunk.get("text", "")[:200].encode()).hexdigest()[:8]
    return f"{src}::{ctype}::{fallback_idx}::{h}"


def _safe_metadata(chunk: Dict[str, Any]) -> Dict[str, Any]:
    """ChromaDB metadata values must be str | int | float | bool."""
    safe: Dict[str, Any] = {}
    for k, v in chunk.items():
        if k == "text":
            continue  # stored as document, not metadata
        if isinstance(v, (str, int, float, bool)):
            safe[k] = v
        elif v is None:
            # ChromaDB does not support None — skip or convert
            safe[k] = ""
        else:
            safe[k] = str(v)
    return safe
