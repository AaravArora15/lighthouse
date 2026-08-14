#!/usr/bin/env bash
#
# Assemble the deployable copy of the scoring service from this repository.
#
#     ml/space/make_space.sh                  # Gradio-SDK Space, the one we deploy
#     ml/space/make_space.sh --flavor docker  # container image, for any Docker host
#     ml/space/make_space.sh /some/dir        # assemble into an existing clone
#
# ## Why this exists
#
# A Space is a git repo that Hugging Face builds and runs. It needs the `lighthouse`
# package, two small artifacts, and a 256MB checkpoint, none of which can simply be
# `git push`ed from here: `data/` is gitignored wholesale and `ml/` has no entry point.
#
# So the Space repo is a build output. Same argument as `web/scripts/sync-fixtures.mjs`:
# copies drift, so a script does the copying and nobody edits the copy. Retrain, rerun
# this, push.
#
# ## The two flavours
#
# `hf` is what we deploy. Docker Spaces on free `cpu-basic` now require PRO, so the free
# route onto Hugging Face is the Gradio SDK on ZeroGPU, with `hf/app.py` mounting the
# FastAPI app at the root.
#
# `docker` is the same service as a plain container, kept because it is what any other
# host wants (Cloud Run, Fly, Render) and because it does not depend on Hugging Face
# pricing staying where it is today.
#
# ## What lands in the build, and what does not
#
# The whole `lighthouse` package is copied rather than the 12 modules `serve/app.py`
# imports. Python source is small and a hand-maintained module list is one more thing to
# get wrong after a refactor. The unimported modules never execute, so their heavy
# dependencies never install.
#
# The fixtures under `fixtures/` are NOT copied. Every `load()` and `load_turn_probs()`
# call site sits in a CLI `__main__` path, verified by walking the import closure of
# `serve/app.py`. The service reads exactly the three artifacts below.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

FLAVOR="hf"
DEST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --flavor) FLAVOR="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) DEST="$1"; shift ;;
  esac
done
DEST="${DEST:-$HERE/build}"

case "$FLAVOR" in
  hf|docker) ;;
  *) echo "error: unknown flavour '$FLAVOR' (want hf or docker)" >&2; exit 1 ;;
esac

ARTIFACTS="$REPO_ROOT/data/artifacts"
CHECKPOINT="$ARTIFACTS/turn_model"

# --------------------------------------------------------------------------------------
# Refuse early rather than pushing something that 503s on every request.
# --------------------------------------------------------------------------------------
if [ ! -f "$CHECKPOINT/model.safetensors" ]; then
  echo "error: no checkpoint at $CHECKPOINT" >&2
  echo "       unzip the Colab checkpoint first:" >&2
  echo "       unzip -o ~/Downloads/lighthouse_turn_model.zip -d data/artifacts/" >&2
  exit 1
fi

for f in turn_calibration.json conversation_head.params.json; do
  if [ ! -f "$ARTIFACTS/$f" ]; then
    echo "error: missing $ARTIFACTS/$f" >&2
    echo "       the service reads this at startup; train or fetch it before deploying" >&2
    exit 1
  fi
done

# --------------------------------------------------------------------------------------
# Assemble
# --------------------------------------------------------------------------------------
echo "assembling '$FLAVOR' into $DEST"
mkdir -p "$DEST/data/artifacts"

# --delete so a module removed from ml/ disappears here too, rather than lingering as a
# stale file that still imports.
rsync -a --delete \
  --exclude '__pycache__/' --exclude '*.pyc' --exclude '.pytest_cache/' \
  "$REPO_ROOT/ml/lighthouse/" "$DEST/lighthouse/"

cp "$ARTIFACTS/turn_calibration.json"         "$DEST/data/artifacts/"
cp "$ARTIFACTS/conversation_head.params.json" "$DEST/data/artifacts/"
rsync -a --delete "$CHECKPOINT/" "$DEST/data/artifacts/turn_model/"

# Entry point last, so a partial run never leaves a deployable-looking directory.
cp "$HERE/.gitattributes" "$DEST/"
cp "$HERE/$FLAVOR"/* "$DEST/"

# Flavours are mutually exclusive: leaving the other one's entry point behind is how you
# push a Gradio Space that Hugging Face tries to build as Docker.
if [ "$FLAVOR" = "hf" ]; then
  rm -f "$DEST/Dockerfile"
else
  rm -f "$DEST/app.py"
fi

# --------------------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------------------
echo
echo "  $(find "$DEST/lighthouse" -name '*.py' | wc -l | tr -d ' ') python files"
echo "  $(du -sh "$DEST/data/artifacts/turn_model" | cut -f1) checkpoint"
echo "  $(du -sh "$DEST" | cut -f1) total"
echo
if [ "$FLAVOR" = "hf" ]; then
  echo "next: upload to the Space (huggingface_hub handles LFS)"
  echo "  python -c \"from huggingface_hub import upload_folder; \\"
  echo "    upload_folder(folder_path='$DEST', repo_id='<user>/lighthouse-scoring', repo_type='space')\""
else
  echo "next: build and run it"
  echo "  docker build -t lighthouse-scoring $DEST && docker run -p 7860:7860 lighthouse-scoring"
fi
