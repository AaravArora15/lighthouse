# The scoring service, as Hugging Face Spaces runs it.
#
# Copied into `build/` by `make_space.sh` and pushed to a Space repo. Nothing in the Space
# repo is edited by hand: it is a build output, the same way `web/src/fixtures/` is, and
# for the same reason. Hand-edit the copy and it drifts from `ml/` with no test to catch it.
#
# Two lines here are load-bearing and will cost you a failed build if they move:
#
#   1. torch installs from the PyTorch CPU index, on its own, BEFORE requirements.txt. The
#      default PyPI wheel for linux/amd64 bundles the CUDA runtime and drags in ~2.5GB of
#      nvidia-* packages, onto a Space that has no GPU.
#   2. The container listens on 7860, which is the port HF routes to. `app_port` in
#      README.md must agree with it.

FROM python:3.12-slim

# Spaces run the container as uid 1000, and /home/user is the only directory you can count
# on being writable. HF_HOME has to land there or transformers fails on first model load.
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    HF_HOME=/home/user/.cache/huggingface \
    PYTHONUNBUFFERED=1 \
    LIGHTHOUSE_DATA_DIR=/home/user/app/data

WORKDIR /home/user/app

# Verified locally at 2.13.0. Relax to >=2.4 if the CPU index has dropped this exact wheel.
RUN pip install --no-cache-dir --user torch==2.13.0 \
      --index-url https://download.pytorch.org/whl/cpu

COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

# Source and artifacts last: they change on every rebuild, the wheels above do not, so this
# ordering keeps the expensive layer cached.
COPY --chown=user lighthouse/ lighthouse/
COPY --chown=user data/ data/

EXPOSE 7860

# `python -m uvicorn` rather than the console script, so this does not depend on
# ~/.local/bin having made it onto PATH.
CMD ["python", "-m", "uvicorn", "lighthouse.serve.app:app", "--host", "0.0.0.0", "--port", "7860"]
