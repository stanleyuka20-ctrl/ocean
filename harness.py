"""harness.py -- the one capture path every quantitative test uses.

AUTHORITATIVE_SOURCE = PAGE_SCREENSHOT (the compositor).

This says the opposite of what it said before, and the reversal is the most
expensive thing in this project's history.

GPU readback was tried twice: `engine.readPixels()` on the default framebuffer,
and a trailing PassPostProcess tap copied with CopyTextureToTexture.  BOTH
returned a sparse high-frequency intermediate rather than the colour frame --
black almost everywhere, with thin bright filaments along the wave crests and
the horizon.  Two properties of that buffer made it look like a superb
instrument:

  * it is EMPTY when the temporal filter is off, so every "TAA off" control
    measured a flawless 0.0000 RMS and read as a perfectly deterministic
    renderer;
  * it FILLS IN as history accumulates, so after a camera stop it decayed to
    zero over ~128 frames on ~2% of pixels along mid-distance wave crests.

That decay is the entire "camera-motion settling" that was pursued through an
ocean-simulation freeze hook, a self-validating subsystem bisection, a
render-stage walk and this very migration.  It was never in the rendered image.
Saving one frame from each path and LOOKING at them ended it in a minute: 676 KB
of correct ocean from the compositor against 2.7 KB of pure black.

The lesson is not "prefer screenshots".  It is that a reader must be calibrated
against a KNOWN ANSWER, never against another reader -- two readers disagreeing
tells you only that they disagree.  The tell was available for a long time and
went unread: TAA debug channel 1 outputs `cur`, the resolve's own INPUT, which
is a plain texture2D of textureSampler and cannot depend on the TAA mode.  It
read 20.362 in REPROJECT against 0.000 in NONE.

The compositor's real weakness is latency, not content: with the render loop
paused and frames issued synchronously inside one evaluate(), a screenshot can
return the previous composite.  That is handled here by settling the compositor
explicitly and by carrying the frame's identity alongside the pixels, so a
caller can assert it captured the frame it asked for rather than infer it from
timing.

Every harness imports `grab` from here.  Six copies of a capture would drift
apart the way six copies of "frozen" already did.
"""
import base64
import io as _io

from PIL import Image, ImageChops, ImageStat

#: canonical comparison size -- captures taken at a larger backbuffer (the
#: supersampled reference) are resolved down to this before any metric runs
CANON = (1280, 720)

#: the compositor needs a beat to pick up hand-stepped frames; two identical
#: consecutive reads mean it has caught up
SETTLE_TRIES = 6
SETTLE_MS = 60


def _shot(page):
    return Image.open(_io.BytesIO(page.screenshot()))


def grab(page, canon=True, fingerprint=False, settle=True):
    """The presented frame, as a PIL image, with the frame's identity.

    Returns (image, meta).  `meta` carries renderedFrameId / simTime /
    cameraHash so a caller can assert it captured the frame it asked for
    instead of inferring it from timing.

    `settle` reads until two consecutive composites agree, which is what makes
    a screenshot safe to use while the render loop is paused.  Pass False only
    when the loop is running freely and the extra reads would cost more than
    they buy.
    """
    im = _shot(page)
    # Settling is only meaningful while the render loop is PAUSED.  With it
    # running the sea moves between reads, so consecutive captures can never
    # agree: the loop would burn every try, cost six screenshots and return the
    # last frame regardless.  Hand-stepped frames are the case that needs it.
    if settle and page.evaluate("!!window.__app.paused"):
        prev = im
        for _ in range(SETTLE_TRIES):
            page.wait_for_timeout(SETTLE_MS)
            cur = _shot(page)
            if _same(cur, prev):
                im = cur
                break
            prev, im = cur, cur
    meta = page.evaluate("window.__frameId()")
    im = im.convert("L")
    if canon and im.size != CANON:
        # A larger backbuffer is a genuine supersample; resolving it here makes
        # that explicit instead of relying on the compositor to do it.
        im = im.resize(CANON, Image.LANCZOS)
    return im, meta


def _same(a, b):
    if a.size != b.size:
        return False
    return ImageStat.Stat(ImageChops.difference(a.convert("L"),
                                                b.convert("L"))).rms[0] < 1e-6


def grab_img(page, crop=None, canon=True):
    """Just the image, optionally cropped -- the common case."""
    im, _ = grab(page, canon=canon)
    return im.crop(crop) if crop else im
