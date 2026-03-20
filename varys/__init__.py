"""Varys — your DS assistant for Jupyter Notebook."""
import os.path as osp

try:
    from ._version import __version__
except ImportError:
    import importlib.metadata
    try:
        __version__ = importlib.metadata.version("varys")
    except importlib.metadata.PackageNotFoundError:
        __version__ = "0.0.0"

def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": "varys"}]


def _jupyter_server_extension_points():
    # Do NOT include "app" here. The ExtensionApp class-based loader path
    # fails in certain jupyter_server 2.x contexts because the traitlet
    # validator that creates DSAssistantExtension() runs at registration
    # time (before the server is fully initialised), and the resulting
    # instance can be silently dropped, leaving self.app=None.  Using only
    # "module" forces jupyter_server to call the module-level
    # _load_jupyter_server_extension below, which is explicit and reliable.
    return [{"module": "varys", "name": "varys"}]


def _load_jupyter_server_extension(serverapp):
    """Load the Jupyter server extension."""
    # Lazy import: DSAssistantExtension (and its entire dependency chain —
    # handlers, LLM providers, httpx, anthropic, etc.) must NOT be imported
    # at package level.  When the kernel runs `%load_ext varys.magic`, Python
    # executes varys/__init__.py first; a top-level import here would cold-load
    # every Varys server module from disk, causing a 20+ second hang on HDDs.
    from .app import DSAssistantExtension  # noqa: PLC0415
    ext = DSAssistantExtension()
    ext._link_jupyter_server_extension(serverapp)
    ext.initialize()


# Keep the legacy name so older jupyter_server versions (< 2) still work.
load_jupyter_server_extension = _load_jupyter_server_extension
