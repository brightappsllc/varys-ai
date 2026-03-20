"""Path utilities for DS Assistant.

All persistent data (chats, skills, memory, RAG, repro DB) lives under a
`.jupyter-assistant/` folder that is **co-located with the notebook** rather
than at the JupyterLab root.  This keeps each project's data self-contained.

Example
-------
  root_dir      = /home/user/projects          (where JupyterLab was started)
  notebook_path = work/analysis/eda.ipynb      (relative to root_dir)
  nb_base(...)  = /home/user/projects/work/analysis/.jupyter-assistant

When the notebook is at the root (e.g. notebook_path = "eda.ipynb"), the
base is identical to the old behaviour: root_dir/.jupyter-assistant.
"""
from pathlib import Path


def nb_base(root_dir: str, notebook_path: str = "") -> Path:
    """Return the .jupyter-assistant directory for a notebook.

    Args:
        root_dir:      Absolute path of the JupyterLab notebook directory.
        notebook_path: Notebook path, relative *or* absolute.
                       Pass ``""`` to get the root-level base (e.g. at startup).
    """
    root = Path(root_dir)
    if notebook_path:
        nb = Path(notebook_path)
        # Convert absolute path to relative so we can anchor it under root_dir.
        if nb.is_absolute():
            try:
                nb = nb.relative_to(root)
            except ValueError:
                # Different drive / outside root — use notebook's parent directly
                return nb.parent / ".jupyter-assistant"
        return (root / nb).parent / ".jupyter-assistant"
    return root / ".jupyter-assistant"
