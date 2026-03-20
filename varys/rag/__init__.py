"""RAG (Retrieval-Augmented Generation) module for DS Assistant.

Optional feature — requires:
    pip install "varys[rag]"
    i.e. chromadb, sentence-transformers, pymupdf

Public API
----------
    from varys.rag.manager import RAGManager
    mgr = RAGManager(root_dir)
    mgr.is_available()          → bool
    mgr.learn(path)             → dict  (indexed files, chunks, errors)
    mgr.ask(query)              → dict  (chunks, context_str)
    mgr.forget(path)            → dict
    mgr.status()                → dict
"""
