# Varys — Installation

## Requirements

- Python 3.9+
- No Node.js required

---

## Install

### Step 1 — Create a virtual environment

```bash
python3 -m venv .py3env
source .py3env/bin/activate
```

### Step 2 — Install Varys-ai with your LLM provider

Pick **one** of the following:

```bash
# Anthropic (Claude)
pip install "varys[anthropic] @ git+https://github.com/brightappsllc/varys-ai"

# OpenAI (GPT)
pip install "varys[openai] @ git+https://github.com/brightappsllc/varys-ai"

# Ollama (local models)
pip install "varys[ollama] @ git+https://github.com/brightappsllc/varys-ai"

# Everything at once
pip install "varys[all] @ git+https://github.com/brightappsllc/varys-ai"
```

### Step 3 — Configure

On first launch, open the Varys settings panel (gear icon in the sidebar) and set:

| Key | Example |
|---|---|
| `CHAT` | `anthropic` |
| `ANTHROPIC_API_KEY` | `sk-ant-...` |

Settings are saved to `~/.jupyter/varys.env` and persist across projects.

### Step 4 — Launch

```bash
jupyter lab
```

The Varys icon appears in the left sidebar.

---

## Verify installation

```bash
jupyter labextension list   # should show: varys v0.1.0 enabled OK
jupyter server extension list  # should show: varys enabled OK
```

---

## Optional: Ollama (local models)

Ollama is a separate process that runs LLM models locally. Varys connects to it over HTTP.

### Step 1 — Install Ollama (system-wide, not in the venv)

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

### Step 2 — Pull a model

```bash
ollama pull qwen2.5-coder:1.5b-instruct   # small/fast — good for code completion
ollama pull qwen2.5-coder:7b-instruct      # larger — better quality
```

### Step 3 — Start the Ollama server

```bash
ollama serve
```

This runs at `http://localhost:11434` by default. Keep it running before launching JupyterLab.

### Step 4 — Configure Varys

In the Varys settings panel set `COMPLETION` (and/or `CHAT`) to `ollama`
and pick the model you pulled (e.g. `qwen2.5-coder:1.5b-instruct`).

Leave `OLLAMA_URL` **blank** — Varys defaults to `http://localhost:11434` automatically.
Only fill it in if Ollama is running on a different machine or port
(e.g. `http://192.168.1.50:11434`).

---

## Optional: RAG (knowledge indexing)

```bash
pip install "varys[rag] @ git+https://github.com/brightappsllc/varys-ai"
# requires: chromadb
```

---

## Upgrade

```bash
pip install --upgrade "varys[all] @ git+https://github.com/brightappsllc/varys-ai"
```

---

## Uninstall

```bash
pip uninstall varys-ai
```
