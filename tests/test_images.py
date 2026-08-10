"""The header readers that stand in for Pillow.

These matter more than their size suggests: the paginator sizes every figure
from the width and height recorded here, so a wrong answer shows up as text
painted over a picture rather than as a failed import.
"""

import fixtures as fx

from kagi import images as I


class TestContentType:
    def test_sniffs_each_format(self):
        assert I.content_type(fx.png(4, 4)) == "image/png"
        assert I.content_type(fx.jpeg(4, 4)) == "image/jpeg"
        assert I.content_type(fx.gif(4, 4)) == "image/gif"
        assert I.content_type(fx.webp_vp8x(4, 4)) == "image/webp"

    def test_rejects_non_images(self):
        assert I.content_type(b"<html><body>404</body></html>") is None
        assert I.content_type(b"") is None
        # A RIFF container that is not WebP (a WAV, say) must not pass.
        assert I.content_type(b"RIFF\x00\x00\x00\x00WAVEfmt ") is None

    def test_extension_falls_back(self):
        assert I.extension("image/jpeg") == "jpg"
        assert I.extension(None) == "bin"


class TestDimensions:
    def test_png(self):
        assert I.dimensions(fx.png(37, 11)) == (37, 11)

    def test_gif(self):
        assert I.dimensions(fx.gif(320, 240)) == (320, 240)

    def test_baseline_jpeg(self):
        assert I.dimensions(fx.jpeg(1200, 800)) == (1200, 800)

    def test_progressive_jpeg_with_fill_bytes(self):
        # Skipping only one 0xFF is the classic bug; this is the case that
        # catches it.
        assert I.dimensions(fx.jpeg(640, 480, progressive=True)) == (640, 480)

    def test_webp_extended_and_lossless(self):
        assert I.dimensions(fx.webp_vp8x(1600, 900)) == (1600, 900)
        assert I.dimensions(fx.webp_vp8l(800, 600)) == (800, 600)

    def test_unreadable_returns_none(self):
        assert I.dimensions(b"not an image at all") is None
        # Truncated headers must be None, never a partial guess or an exception.
        assert I.dimensions(fx.png(10, 10)[:12]) is None
        assert I.dimensions(fx.jpeg(10, 10)[:4]) is None

    def test_jpeg_without_a_frame_header(self):
        # Only an end-of-image marker: no size to be had, and no infinite loop.
        assert I.dimensions(b"\xff\xd8\xff\xd9") is None
