"""High-level RAG manager for DS Assistant.

Public API
----------
    mgr = RAGManager(base_dir)  # base_dir = nb_base(root_dir, notebook_path)
    mgr.is_available()          → bool
    mgr.learn(path, force)      → LearnResult dict
    mgr.ask(query, top_k)       → AskResult  dict
    mgr.forget(path)            → ForgetResult dict
    mgr.status()                → StatusResult dict

All CPU-bound operations (embedding) must be awaited via
``asyncio.get_event_loop().run_in_executor(None, ...)`` in the
Tornado handler — the synchronous methods here are thread-safe.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional

from .chunker import chunk_file, find_files
from .store import RAGStore
from ..utils.config import get_config as _get_cfg

log = logging.getLogger(__name__)

_CACHE_FILE = "file_hashes.json"


class RAGManager:

    def __init__(self, base_dir: "str | Path") -> None:
        """Args:
            base_dir: The .jupyter-assistant directory for this notebook.
                      Use ``nb_base(root_dir, notebook_path)`` to obtain it.
        """
        self._base_dir  = Path(base_dir)
        self._store     = RAGStore(base_dir)
        self._cache_dir = self._base_dir / "rag"
        self._embedder: Optional[Any] = None  # lazy

    # ── Dependency check ───────────────────────────────────────────────────

    @staticmethod
    def is_available() -> bool:
        """True iff all required RAG dependencies are installed.

        For the 'ollama' backend, only chromadb is required (no PyTorch).
        For 'sentence_transformers' backend, both chromadb and
        sentence_transformers must be importable.
        """
        try:
            import chromadb  # noqa: F401
        except ImportError:
            return False
        provider = (
            os.environ.get("DS_EMBED_PROVIDER", "")
            or os.environ.get("DS_RAG_EMBED_BACKEND", "")
        ).upper()
        # Non-local providers need only chromadb (API calls at runtime)
        if provider in ("OLLAMA", "OPENAI", "GOOGLE", "AZURE"):
            return True
        try:
            import sentence_transformers  # noqa: F401
            return True
        except ImportError:
            return False

    @staticmethod
    def install_hint() -> str:
        provider = (
            os.environ.get("DS_EMBED_PROVIDER", "")
            or os.environ.get("DS_RAG_EMBED_BACKEND", "")
        ).upper()
        if provider == "OLLAMA":
            return (
                '⚠️ RAG requires chromadb.\n'
                'Install:  pip install chromadb\n'
                'Then pull an Ollama embedding model:\n'
                '  ollama pull nomic-embed-text'
            )
        if provider in ("OPENAI", "GOOGLE", "AZURE"):
            return (
                f'⚠️ RAG requires chromadb.\n'
                f'Install:  pip install chromadb\n'
                f'Make sure {provider}_API_KEY (and {provider}_EMBED_MODEL) are set.'
            )
        return (
            '⚠️ RAG dependencies missing.\n'
            'Install:  pip install chromadb sentence-transformers\n'
            'For PDF support:  pip install pymupdf'
        )

    # ── Embedding ──────────────────────────────────────────────────────────

    def _get_embedder(self) -> Any:
        """Lazy-load the embedding model (singleton per process).

        Backend selection:
            DS_EMBED_PROVIDER  — provider name (OLLAMA, OPENAI, GOOGLE, SENTENCE_TRANSFORMERS)
            {PROVIDER}_EMBED_MODEL — model name for that provider

        If DS_EMBED_PROVIDER is unset, fall back to sentence_transformers.
        DS_RAG_EMBED_BACKEND / DS_RAG_EMBED_MODEL are still honoured for
        backward compatibility when no DS_EMBED_PROVIDER is set.
        """
        if self._embedder is not None:
            return self._embedder

        # New unified routing key takes priority over old legacy keys.
        provider = (
            os.environ.get("DS_EMBED_PROVIDER", "")
            or os.environ.get("DS_RAG_EMBED_BACKEND", "")
        ).upper().strip()

        # Derive the model name from {PROVIDER}_EMBED_MODEL, falling back to
        # the legacy DS_RAG_EMBED_MODEL key.
        model_name = (
            (os.environ.get(f"{provider}_EMBED_MODEL", "") if provider else "")
            or os.environ.get("DS_RAG_EMBED_MODEL", "")
        ).strip()

        if provider in ("OLLAMA", ""):
            # Default to Ollama when no provider set but Ollama URL is
            # configured, otherwise fall through to sentence_transformers.
            if provider == "OLLAMA" or not provider:
                pass  # handled below
        cfg = _get_cfg()
        if provider == "OLLAMA":
            if not model_name:
                model_name = cfg.get("models", "ollama_embed_model", "nomic-embed-text")
            ollama_url = os.environ.get("OLLAMA_URL", "http://localhost:11434")
            log.info("RAGManager: Ollama embeddings '%s' @ %s", model_name, ollama_url)
            self._embedder = _OllamaEmbedder(ollama_url, model_name)

        elif provider == "OPENAI":
            if not model_name:
                model_name = cfg.get("models", "openai_embed_model", "text-embedding-3-small")
            api_key = os.environ.get("OPENAI_API_KEY", "")
            log.info("RAGManager: OpenAI embeddings '%s'", model_name)
            self._embedder = _OpenAIEmbedder(api_key, model_name)

        elif provider == "GOOGLE":
            if not model_name:
                model_name = cfg.get("models", "google_embed_model", "text-embedding-004")
            api_key = os.environ.get("GOOGLE_API_KEY", "")
            log.info("RAGManager: Google embeddings '%s'", model_name)
            self._embedder = _GoogleEmbedder(api_key, model_name)

        elif provider == "AZURE":
            if not model_name:
                model_name = cfg.get("models", "azure_embed_model", "text-embedding-3-small")
            api_key  = os.environ.get("AZURE_OPENAI_API_KEY", "")
            endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT", "")
            version  = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-02-01")
            log.info("RAGManager: Azure OpenAI embeddings '%s'", model_name)
            self._embedder = _AzureEmbedder(api_key, endpoint, model_name, version)

        else:
            # Default: sentence-transformers (local, no API key needed)
            if not model_name:
                model_name = cfg.get("models", "sentence_transformer_model", "all-MiniLM-L6-v2")
            from sentence_transformers import SentenceTransformer  # type: ignore
            log.info("RAGManager: sentence-transformers '%s'…", model_name)
            self._embedder = SentenceTransformer(model_name)
            log.info("RAGManager: model ready")

        return self._embedder

    def _embed(self, texts: List[str]) -> List[List[float]]:
        model = self._get_embedder()
        # sentence-transformers has a different signature than our custom embedders
        if hasattr(model, "encode") and not isinstance(
            model, (_OllamaEmbedder, _OpenAIEmbedder, _GoogleEmbedder, _AzureEmbedder)
        ):
            batch_sz = _get_cfg().getint("embedding", "embed_batch_size", 32)
            vecs = model.encode(texts, batch_size=batch_sz, show_progress_bar=False)
            return vecs.tolist()
        return model.encode(texts)

    # ── File hash cache ────────────────────────────────────────────────────

    def _cache_path(self) -> Path:
        return self._cache_dir / _CACHE_FILE

    def _load_cache(self) -> Dict[str, str]:
        p = self._cache_path()
        if p.exists():
            try:
                return json.loads(p.read_text())
            except Exception:
                return {}
        return {}

    def _save_cache(self, cache: Dict[str, str]) -> None:
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        _path = self._cache_path()
        _content = json.dumps(cache, indent=2)
        fd, _tmp = tempfile.mkstemp(dir=_path.parent, prefix=".tmp_varys_", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as _fh:
                _fh.write(_content)
            os.replace(_tmp, _path)
        except Exception:
            try:
                os.unlink(_tmp)
            except OSError:
                pass
            raise

    @staticmethod
    def _file_hash(path: str) -> str:
        h = hashlib.md5()
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(65536), b""):
                h.update(block)
        return h.hexdigest()

    # ── Public API ─────────────────────────────────────────────────────────

    def learn(
        self,
        path: str,
        force: bool = False,
        progress_cb: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """Index all supported files at *path*.

        Args:
            path:        File or directory to index.
            force:       Re-index even if file hash unchanged.
            progress_cb: Optional callable(msg: str) for streaming progress.

        Returns a dict with keys: total, processed, skipped, errors.
        """
        files   = find_files(path)
        cache   = self._load_cache()
        results = {"total": len(files), "processed": 0, "skipped": 0, "errors": []}

        def emit(msg: str) -> None:
            if progress_cb:
                try:
                    progress_cb(msg)
                except Exception:
                    pass

        emit(f"📂 Found {len(files)} file(s) to scan…")

        for file_path in files:
            try:
                fhash = self._file_hash(file_path)
                if not force and cache.get(file_path) == fhash:
                    results["skipped"] += 1
                    continue

                chunks = chunk_file(file_path)
                if not chunks:
                    results["skipped"] += 1
                    continue

                texts      = [c["text"] for c in chunks]
                embeddings = self._embed(texts)
                self._store.upsert(chunks, embeddings)
                cache[file_path] = fhash
                results["processed"] += 1
                emit(f"  ✅ {Path(file_path).name} — {len(chunks)} chunk(s)")

            except Exception as exc:
                msg = f"{Path(file_path).name}: {exc}"
                results["errors"].append(msg)
                emit(f"  ❌ {msg}")

        self._save_cache(cache)
        emit(
            f"\n✅ Done — {results['processed']} processed, "
            f"{results['skipped']} skipped, "
            f"{len(results['errors'])} error(s). "
            f"Total chunks in index: {self._store.count()}"
        )
        return results

    def ask(self, query: str, top_k: int = 0) -> Dict[str, Any]:
        """Retrieve the most relevant chunks for *query*.

        Returns:
            chunks:  List of dicts with keys text, source, type, score, etc.
            context: Pre-formatted string ready to inject into an LLM prompt.
        """
        if top_k == 0:
            top_k = _get_cfg().getint("retrieval", "top_k", 5)
        query_vec = self._embed([query])[0]
        raw       = self._store.query(query_vec, top_k=top_k)

        docs      = (raw.get("documents") or [[]])[0]
        metas     = (raw.get("metadatas") or [[]])[0]
        distances = (raw.get("distances") or [[]])[0]

        chunks = []
        for doc, meta, dist in zip(docs, metas, distances):
            chunks.append({
                "text":     doc,
                "source":   meta.get("source_file", ""),
                "type":     meta.get("chunk_type", ""),
                "cell_idx": meta.get("cell_idx"),
                "page":     meta.get("page"),
                "score":    round(1.0 - float(dist), 3),
            })

        context = _format_context(chunks)
        return {"chunks": chunks, "context": context}

    def forget(self, path: str) -> Dict[str, Any]:
        """Remove *path* from the index."""
        n = self._store.delete_by_source(path)
        cache = self._load_cache()
        was_cached = path in cache
        cache.pop(path, None)
        self._save_cache(cache)
        return {"ok": True, "chunks_removed": n, "was_cached": was_cached}

    def status(self) -> Dict[str, Any]:
        """Return a summary of the current index."""
        try:
            sources = self._store.list_sources()
            count   = self._store.count()
        except Exception:
            sources, count = [], 0
        return {
            "available":     self.is_available(),
            "total_chunks":  count,
            "indexed_files": len(sources),
            "files":         sources,
        }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _format_context(chunks: List[Dict[str, Any]]) -> str:
    """Format retrieved chunks into a prompt-ready context block."""
    if not chunks:
        return ""
    parts = []
    for i, c in enumerate(chunks, start=1):
        src  = Path(c["source"]).name if c.get("source") else "unknown"
        loc  = ""
        if c.get("cell_idx") is not None:
            loc = f", cell {c['cell_idx']}"
        elif c.get("page") is not None:
            loc = f", page {c['page']}"
        score = f" (score {c.get('score', '?'):.2f})" if isinstance(c.get("score"), float) else ""
        parts.append(f"[Source {i}: {src}{loc}{score}]\n{c['text']}")
    return "\n\n---\n\n".join(parts)


# ── Ollama embedder ───────────────────────────────────────────────────────────

# ── Provider-specific embedders ──────────────────────────────────────────────
# Each class exposes encode(texts: List[str]) -> List[List[float]]
# to match the sentence-transformers interface used by RAGManager._embed().


class _OllamaEmbedder:
    """Lightweight embedder that calls Ollama's /api/embeddings endpoint.

    Uses the synchronous ``requests`` library (always available via Jupyter's
    own transitive dependencies).  Falls back to ``urllib`` if requests is
    missing for any reason.
    """

    def __init__(self, base_url: str, model: str) -> None:
        self._url   = base_url.rstrip("/") + "/api/embeddings"
        self._model = model

    def encode(self, texts: List[str]) -> List[List[float]]:
        """Return one embedding vector per text in *texts*."""
        results = []
        for text in texts:
            results.append(self._embed_one(text))
        return results

    def _embed_one(self, text: str) -> List[float]:
        payload = json.dumps({"model": self._model, "prompt": text}).encode()
        _t = _get_cfg().getint("embedding", "ollama_embed_timeout", 30)
        try:
            import requests as _req  # type: ignore
            resp = _req.post(self._url, data=payload,
                             headers={"Content-Type": "application/json"}, timeout=_t)
            resp.raise_for_status()
            return resp.json()["embedding"]
        except ImportError:
            import urllib.request
            req = urllib.request.Request(
                self._url,
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=_t) as r:
                return json.loads(r.read())["embedding"]


class _OpenAIEmbedder:
    """Call OpenAI's /embeddings endpoint (or any OpenAI-compatible API)."""

    def __init__(self, api_key: str, model: str) -> None:
        self._api_key = api_key
        self._model   = model
        self._url     = "https://api.openai.com/v1/embeddings"

    def encode(self, texts: List[str]) -> List[List[float]]:
        """Batch all texts in a single API call (OpenAI supports up to 2048 inputs)."""
        payload = json.dumps({"model": self._model, "input": texts}).encode()
        _t = _get_cfg().getint("embedding", "openai_embed_timeout", 60)
        try:
            import requests as _req  # type: ignore
            resp = _req.post(
                self._url,
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self._api_key}",
                },
                timeout=_t,
            )
            resp.raise_for_status()
            data = resp.json()["data"]
        except ImportError:
            import urllib.request
            req = urllib.request.Request(
                self._url,
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self._api_key}",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=_t) as r:
                data = json.loads(r.read())["data"]
        # OpenAI returns objects sorted by index
        return [item["embedding"] for item in sorted(data, key=lambda x: x["index"])]


class _GoogleEmbedder:
    """Call Google's text-embedding API via google-genai (the same SDK used for chat).

    Uses client.models.embed_content() which supports batched input and returns
    response.embeddings[i].values — consistent with google-genai >= 0.8.
    """

    def __init__(self, api_key: str, model: str) -> None:
        self._api_key = api_key
        self._model   = model

    def encode(self, texts: List[str]) -> List[List[float]]:
        from google import genai  # type: ignore  (google-genai package)
        from google.genai import types as _gtypes  # type: ignore
        client = genai.Client(api_key=self._api_key)
        response = client.models.embed_content(
            model=self._model,
            contents=texts,
            config=_gtypes.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT"),
        )
        return [e.values for e in response.embeddings]


class _AzureEmbedder:
    """Call Azure OpenAI's embeddings endpoint."""

    def __init__(self, api_key: str, endpoint: str, deployment: str, api_version: str) -> None:
        self._api_key    = api_key
        self._deployment = deployment
        self._url = (
            f"{endpoint.rstrip('/')}/openai/deployments/{deployment}"
            f"/embeddings?api-version={api_version}"
        )

    def encode(self, texts: List[str]) -> List[List[float]]:
        payload = json.dumps({"input": texts}).encode()
        _t = _get_cfg().getint("embedding", "openai_embed_timeout", 60)
        try:
            import requests as _req  # type: ignore
            resp = _req.post(
                self._url,
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "api-key": self._api_key,
                },
                timeout=_t,
            )
            resp.raise_for_status()
            data = resp.json()["data"]
        except ImportError:
            import urllib.request
            req = urllib.request.Request(
                self._url,
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "api-key": self._api_key,
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=_t) as r:
                data = json.loads(r.read())["data"]
        return [item["embedding"] for item in sorted(data, key=lambda x: x["index"])]
