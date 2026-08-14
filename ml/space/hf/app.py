"""Hugging Face Space entry point: the scoring service, wrapped for the Gradio SDK.

## Why this adapter exists

The service is a FastAPI app (`lighthouse/serve/app.py`) and wants nothing to do with
Gradio. But Docker Spaces on free `cpu-basic` now answer 402:

    Static Spaces are free for everyone, but hosting Gradio and Docker Spaces on free
    cpu-basic requires a PRO subscription.

A Gradio Space on ZeroGPU hardware does not. Verified by probe on 2026-08-13: a free
account created one and it reached RUNNING on `zero-a10g`. So the free route onto Hugging
Face runs through the Gradio SDK, and this file is the adapter. It contains no triage
logic and must never grow any.

## Why Gradio owns the server and we graft routes onto it

The obvious shape, `gr.mount_gradio_app(api, demo, ...)` plus `uvicorn.run`, does not work
on a Space and fails twice over. Observed on the first deploy:

    ERROR: [Errno 98] error while attempting to bind on address ('0.0.0.0', 7860):
           address already in use
    RUNTIME_ERROR: No @spaces.GPU function detected during startup

The Gradio SDK runner has already bound 7860 by the time `__main__` runs, and ZeroGPU's
startup scan hooks `Blocks.launch()`, so bypassing launch means the platform never sees the
decorated function. Both problems have the same fix: let Gradio be the server, and attach
the two service routes to the FastAPI instance it builds.

The routes keep their exact paths, so `POST /score` and `GET /health` are what
`web/src/lib/classifier.ts` already calls, with no change at the other end. The Gradio page
stays at `/`, because a Space that renders a stack trace is a bad look on a submission page.

## Why the model still runs on CPU

ZeroGPU hands a GPU to functions decorated with `@spaces.GPU`, and only for the duration of
that call. `TurnScorer` loads its checkpoint lazily and then holds it across requests,
which is the opposite shape: the fork-and-initialise dance the decorator performs would be
a failure mode added for no gain. A DistilBERT scores a conversation in about 30ms on CPU.

`gpu_selftest` exists so the Space still declares a GPU entry point and so a judge can
confirm the hardware is real. Nothing on the scoring path calls it.
"""

import os
from pathlib import Path

# MUST precede the lighthouse import. `config.py` resolves ARTIFACTS_DIR at import time,
# and its default is REPO_ROOT/data, which on a Space points one level ABOVE this file.
# Set it wrong and the service starts happily and 503s on every request.
os.environ.setdefault("LIGHTHOUSE_DATA_DIR", str(Path(__file__).parent / "data"))

import gradio as gr  # noqa: E402
import spaces  # noqa: E402

from lighthouse.serve.app import app as api  # noqa: E402


@spaces.GPU(duration=15)
def gpu_selftest() -> str:
    """Off the scoring path. Proves the ZeroGPU allocation is real, nothing more."""
    import torch

    if not torch.cuda.is_available():
        return "no CUDA device in this allocation"
    return f"{torch.cuda.get_device_name(0)}, torch {torch.__version__}"


with gr.Blocks(title="Lighthouse scoring service") as demo:
    gr.Markdown(
        """
        # Lighthouse scoring service

        The classifier half of Lighthouse, behind one HTTP call. A fine-tuned turn
        classifier, a logistic conversation head with isotonic calibration, and a
        deterministic safety gate, returning a finished escalation card.

        **Every conversation this service was trained and demonstrated on is synthetic.**
        No real student ever spoke to it. This is a listening and routing tool: it does
        not diagnose, treat, or offer therapy.

        This page is not the product. The API is:

        | Route | Purpose |
        |---|---|
        | `GET /health` | liveness, and whether the checkpoint is present and loaded |
        | `POST /score` | one conversation in, one escalation card out |

        The first `/score` after a cold start takes about ten seconds while the checkpoint
        loads. Every one after it is about 30ms.

        This service cannot decide whether a student sees crisis resources. That already
        happened, in the browser, before this service was contacted, from a safety gate
        that runs in about 123µs with no network. Nothing returned here can revoke it.
        """
    )
    with gr.Row():
        selftest = gr.Button("GPU self-test", variant="secondary")
        selftest_out = gr.Textbox(label="allocation", interactive=False)
    selftest.click(gpu_selftest, outputs=selftest_out)


SERVICE_ROUTES = ("/health", "/score")


def graft(target, source, paths):
    """Move `source`'s routes onto `target`, preserving their paths.

    Starlette's router is a plain list consulted per request, so this can happen after
    `launch()` is already serving. It must **prepend**: Gradio registers a catch-all
    `/{path:path}` for its single-page frontend, and first match wins. Appending produced a
    Space that looked healthy and answered `GET /health` with a page of HTML, and `POST
    /score` with a 405.

    Asserting the result afterwards, because a silent no-op here is indistinguishable from
    a working deploy until something tries to score.
    """
    grafted = [r for r in source.routes if getattr(r, "path", None) in paths]
    target.router.routes[:0] = grafted
    return [r.path for r in grafted]


if __name__ == "__main__":
    # ssr_mode=False is not cosmetic. Gradio 6 defaults to server-side rendering, which
    # puts a Node proxy on 7860 in front of Python on 7861:
    #
    #     * Running on local URL: http://0.0.0.0:7860, with SSR (Node proxy -> Python :7861)
    #
    # That proxy answers paths it does not recognise with the single-page app, so grafted
    # routes on the Python side are never reached: `GET /health` returned a page of HTML
    # and `POST /score` a 405, with the graft reporting success in the same logs. Turning
    # SSR off gives Python port 7860 directly. We render one static markdown page; there is
    # nothing here for SSR to accelerate.
    #
    # prevent_thread_lock so control returns for the graft, then we block by hand. Host and
    # port are left to Gradio, which reads what the Space sets.
    demo.launch(prevent_thread_lock=True, ssr_mode=False)

    added = graft(demo.app, api, SERVICE_ROUTES)
    if sorted(added) != sorted(SERVICE_ROUTES):
        raise RuntimeError(f"expected {SERVICE_ROUTES} on the service app, grafted {added}")
    print(f"[lighthouse] serving {', '.join(added)} alongside the Gradio page", flush=True)

    demo.block_thread()
