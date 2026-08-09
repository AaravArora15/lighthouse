#!/usr/bin/env bash
# Build the upload bundle for the Colab fine-tune.
#
#     bash ml/colab/make_bundle.sh
#
# Produces data/artifacts/lighthouse_bundle.tar.gz (~16MB): the lighthouse package plus
# the three split parquets, laid out at the same relative paths the repo uses. That
# matters: config.py derives DATA_DIR from the package location, so extracting this
# tarball anywhere gives a tree the training script can read with no env vars and no
# path edits.
#
# Re-run this after ANY change to ml/lighthouse/ or data/splits/. The bundle is a
# snapshot, and a stale one silently trains yesterday's code.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$REPO_ROOT/data/artifacts/lighthouse_bundle.tar.gz"

cd "$REPO_ROOT"

for f in data/splits/turns_train.parquet data/splits/turns_val.parquet data/splits/turns_test.parquet; do
    [ -f "$f" ] || { echo "missing $f — run: python -m lighthouse.data.build_splits" >&2; exit 1; }
done

mkdir -p "$(dirname "$OUT")"

EXTRA=()
# Ships so the run prints its delta against the day 1 baseline in Colab, rather than us
# computing it by hand after the fact. 1KB; skipped silently if the baseline hasn't run.
[ -f data/artifacts/baseline_tfidf.json ] && EXTRA+=(data/artifacts/baseline_tfidf.json)

# --exclude on __pycache__ keeps stale .pyc files from shadowing edited sources.
tar --exclude='__pycache__' --exclude='.DS_Store' -czf "$OUT" \
    ml/lighthouse \
    ml/pyproject.toml \
    data/splits/turns_train.parquet \
    data/splits/turns_val.parquet \
    data/splits/turns_test.parquet \
    "${EXTRA[@]}"

echo "wrote $OUT"
ls -lh "$OUT" | awk '{print "  size:", $5}'
echo
echo "next: upload it in ml/colab/train_turn_colab.ipynb (Colab, T4 runtime)"
