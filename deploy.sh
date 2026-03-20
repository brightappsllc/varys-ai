#!/usr/bin/env bash
# deploy.sh — build the Varys frontend and copy the JS bundle to the .varys env.
# Usage:  ./deploy.sh   (build JS + copy static files)
#
# Python changes are picked up automatically on the next JupyterLab restart
# because .varys uses an editable install (_varys.pth pointing at this source
# tree).  If you ever reinstall with pip, use: pip install --no-deps -e .
# then remove any broken symlink at .varys/share/jupyter/labextensions/varys.
set -e

VARYSENV="/media/jmlb/datastore-8tb1/.varys"
SRC="/media/jmlb/datastore-8tb1/my_ideas/varys-ai"

source "$VARYSENV/bin/activate"
cd "$SRC"

# ── Guard: reject the unrelated beOn/varys PyPI package if somehow installed.
# Never run pip install here — it copies Python files to site-packages and
# shadows the _varys.pth source-tree redirect.
INSTALLED_URL=$(pip show varys 2>/dev/null | grep "^Home-page:" | head -1)
if echo "$INSTALLED_URL" | grep -q "beOn"; then
    echo "ERROR: Wrong 'varys' package detected ($INSTALLED_URL)."
    echo "Run: pip uninstall varys -y  then re-run deploy.sh"
    exit 1
fi
# Also ensure the extension config is present so JupyterLab actually loads it.
EXT_CFG="$VARYSENV/etc/jupyter/jupyter_server_config.d/varys.json"
if [ ! -f "$EXT_CFG" ]; then
    echo "==> Installing Jupyter server extension config..."
    mkdir -p "$(dirname "$EXT_CFG")"
    cp "$SRC/jupyter-config/jupyter_server_config.d/varys.json" "$EXT_CFG"
fi

echo "==> Compiling TypeScript..."
npx tsc

echo "==> Building webpack bundle..."
jupyter labextension build .

STATIC_SRC="$SRC/varys/labextension/static"
REMOTE_ENTRY=$(ls "$STATIC_SRC"/remoteEntry.*.js | xargs basename)
echo "==> New remoteEntry: $REMOTE_ENTRY"

# JupyterLab loads the extension from share/jupyter/labextensions/varys/.
# The site-packages/varys/ directory is intentionally absent — Python loads
# the varys package directly from the source tree via _varys.pth.
# Never copy to site-packages here; doing so shadows the .pth and breaks
# live Python edits.
LAB_STATIC="$VARYSENV/share/jupyter/labextensions/varys/static"

# Wipe stale chunks before copying so old bundles can't be accidentally loaded.
rm -f "$LAB_STATIC"/*.js "$LAB_STATIC"/*.js.LICENSE.txt "$LAB_STATIC"/*.css 2>/dev/null || true

cp "$STATIC_SRC"/* "$LAB_STATIC/"

# Ensure package.json at the labextension root points to the new remoteEntry.
PKG_JSON_SRC="$SRC/varys/labextension/package.json"
cp "$PKG_JSON_SRC" "$VARYSENV/share/jupyter/labextensions/varys/package.json"
echo "    Copied static files → $VARYSENV"

python3 - <<PYEOF
import json
new_load = "static/$REMOTE_ENTRY"
path = "$LAB_STATIC/../package.json"
with open(path) as f:
    d = json.load(f)
d["jupyterlab"]["_build"]["load"] = new_load
with open(path, "w") as f:
    json.dump(d, f, indent=2)
print(f"    Updated {path} -> {new_load}")
PYEOF

# CRITICAL: remove any site-packages/varys/ directory.
# Python's import system finds site-packages/varys/ BEFORE the _varys.pth-added
# path, so a full copy there silently shadows all source-tree edits — Python
# loads the stale copy no matter how many times you edit the source.
# The correct state: no varys/ in site-packages, only _varys.pth → source tree.
SITE_VARYS="$VARYSENV/lib/python3.12/site-packages/varys"
if [ -d "$SITE_VARYS" ]; then
    echo "==> Removing stale $SITE_VARYS (shadows source tree via .pth)..."
    rm -rf "$SITE_VARYS"
fi

echo ""
echo "Done. Hard-refresh the browser (Ctrl+Shift+R)."
echo "If Python files changed, restart JupyterLab first."
