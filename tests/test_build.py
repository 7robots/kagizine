"""Assembling an edition, with the network and R2 replaced by dictionaries.

This is where the failure modes live: a feed that 500s, a picture that comes
back as an HTML error page, the same story syndicated into two sections. The
Worker's cron runs unattended once a day, so anything that turns a partial
failure into no edition at all is worth a test.
"""

import asyncio

import fixtures as fx
import pytest

from kagi import build as B
from kagi import feed as F

BUILT = "Mon, 10 Aug 2026 12:01:32 +0000"

TWO_FEEDS = [
    {"slug": "world", "title": "World", "url": "https://feed/world"},
    {"slug": "science", "title": "Science", "url": "https://feed/science"},
]


class Fake:
    """Stands in for fetch and for the R2 bucket."""

    def __init__(self, responses: dict):
        self.responses = responses
        self.stored: dict[str, bytes] = {}
        self.requests: list[str] = []
        self.puts: list[str] = []

    async def fetch_bytes(self, url):
        self.requests.append(url)
        value = self.responses.get(url)
        if value is None:
            raise RuntimeError("404 for %s" % url)
        if isinstance(value, Exception):
            raise value
        return value, None

    async def put_image(self, key, data, content_type):
        self.puts.append(key)
        self.stored[key] = data


def feeds_with(world_items: str, science_items: str = "", **images) -> Fake:
    responses = {
        "https://feed/world": fx.channel("World", BUILT, world_items),
        "https://feed/science": fx.channel("Science", BUILT, science_items),
    }
    responses.update(images)
    return Fake(responses)


class TestGatherLimited:
    async def test_preserves_order_and_limits_concurrency(self):
        live = 0
        peak = 0

        def make(i):
            async def run():
                nonlocal live, peak
                live += 1
                peak = max(peak, live)
                await asyncio.sleep(0)
                live -= 1
                return i

            return run

        out = await B.gather_limited([make(i) for i in range(20)], limit=4)
        assert out == list(range(20))
        assert peak <= 4

    async def test_captures_failures_without_sinking_the_batch(self):
        async def ok():
            return "fine"

        async def boom():
            raise RuntimeError("nope")

        out = await B.gather_limited([lambda: ok(), lambda: boom(), lambda: ok()])
        assert out[0] == "fine"
        assert isinstance(out[1], RuntimeError)
        assert out[2] == "fine"

    async def test_empty(self):
        assert await B.gather_limited([]) == []


class TestBuildEdition:
    async def test_happy_path(self):
        fake = feeds_with(
            fx.item("Wildfires spread", extras=fx.FULL_BODY_EXTRAS),
            fx.item("A new telescope", section="Science", sub="Astronomy"),
            **{"https://img.example/one.png": fx.png(1600, 900)},
        )
        edition, articles, report = await B.build_edition(
            fake.fetch_bytes, fake.put_image, TWO_FEEDS
        )

        assert edition["date"] == "2026-08-10"
        assert edition["title"] == "Kagi News, 10 August 2026"
        assert edition["weekday"] == "Monday"
        assert edition["built_from"] == BUILT
        assert [s["slug"] for s in edition["sections"]] == ["world", "science"]
        assert len(articles) == 2
        assert report["failures"] == []
        assert report["articles"] == 2

    async def test_cover_comes_from_the_lead_story(self):
        fake = feeds_with(
            fx.item("Lead", image="https://img.example/lead.png"),
            fx.item("Second", section="Science", image="https://img.example/two.png"),
            **{
                "https://img.example/lead.png": fx.png(1200, 800),
                "https://img.example/two.png": fx.png(400, 400),
            },
        )
        edition, articles, _ = await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS)
        lead_figure = articles["world/lead"]["blocks"][0]
        assert edition["cover_asset"] == lead_figure["asset"]

    async def test_identical_pictures_are_stored_once(self):
        same = fx.png(800, 600)
        fake = feeds_with(
            fx.item("One", image="https://img.example/a.png")
            + fx.item("Two", image="https://img.example/b.png"),
            "",
            **{"https://img.example/a.png": same, "https://img.example/b.png": same},
        )
        _, articles, _ = await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS)
        assets = {a["blocks"][0]["asset"] for a in articles.values()}
        assert len(assets) == 1, "content addressing should collapse identical bytes"
        assert len(fake.stored) == 1

    async def test_a_story_in_two_feeds_is_kept_once_in_reading_order(self):
        shared = "Shared headline"
        fake = feeds_with(
            fx.item(shared),
            fx.item(shared, section="Science"),
            **{"https://img.example/one.png": fx.png(100, 100)},
        )
        edition, articles, report = await B.build_edition(
            fake.fetch_bytes, fake.put_image, TWO_FEEDS
        )
        assert len(articles) == 1
        assert "world/shared-headline" in articles
        assert [s["slug"] for s in edition["sections"]] == ["world"]
        assert any("duplicate" in w for w in report["warnings"])

    async def test_one_feed_failing_still_produces_an_edition(self):
        fake = Fake(
            {
                "https://feed/world": RuntimeError("upstream 503"),
                "https://feed/science": fx.channel("Science", BUILT, fx.item("Alive", section="Science")),
                "https://img.example/one.png": fx.png(100, 100),
            }
        )
        edition, articles, report = await B.build_edition(
            fake.fetch_bytes, fake.put_image, TWO_FEEDS
        )
        assert len(articles) == 1
        assert [f["feed"] for f in report["failures"]] == ["world"]
        assert [s["slug"] for s in edition["sections"]] == ["science"]

    async def test_malformed_xml_is_a_feed_failure_not_a_crash(self):
        fake = Fake(
            {
                "https://feed/world": b"<rss><not-a-channel/></rss>",
                "https://feed/science": fx.channel("Science", BUILT, fx.item("Alive", section="Science")),
                "https://img.example/one.png": fx.png(100, 100),
            }
        )
        _, articles, report = await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS)
        assert len(articles) == 1
        assert report["failures"][0]["feed"] == "world"

    async def test_every_feed_failing_raises(self):
        fake = Fake({})
        with pytest.raises(ValueError, match="lastBuildDate"):
            await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS)

    async def test_feeds_with_no_build_date_refuse_to_guess(self):
        fake = Fake(
            {
                "https://feed/world": fx.channel("World", "", fx.item("One")),
                "https://feed/science": fx.channel("Science", "", ""),
            }
        )
        with pytest.raises(ValueError, match="refusing to guess"):
            await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS)

    async def test_empty_feeds_raise_rather_than_publishing_nothing(self):
        fake = Fake(
            {
                "https://feed/world": fx.channel("World", BUILT, ""),
                "https://feed/science": fx.channel("Science", BUILT, ""),
            }
        )
        with pytest.raises(ValueError, match="empty"):
            await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS)

    async def test_a_missing_picture_costs_only_the_picture(self):
        fake = feeds_with(fx.item("No picture for me"))  # image URL not in responses
        _, articles, report = await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS)
        article = articles["world/no-picture-for-me"]
        assert all(b["kind"] != "figure" for b in article["blocks"])
        assert article["word_count"] > 0
        assert any("picture unavailable" in w for w in report["warnings"])

    async def test_an_html_error_page_is_not_treated_as_a_picture(self):
        fake = feeds_with(
            fx.item("Story"),
            "",
            **{"https://img.example/one.png": b"<html><body>Forbidden</body></html>" * 40},
        )
        _, articles, report = await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS)
        assert fake.puts == []
        assert all(b["kind"] != "figure" for b in articles["world/story"]["blocks"])
        assert any("picture unavailable" in w for w in report["warnings"])

    async def test_a_truncated_picture_is_rejected(self):
        fake = feeds_with(
            fx.item("Story"), "", **{"https://img.example/one.png": fx.png(100, 100)[:200]}
        )
        _, articles, _ = await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS)
        assert all(b["kind"] != "figure" for b in articles["world/story"]["blocks"])

    async def test_stub_items_are_flagged_but_kept(self):
        fake = feeds_with(fx.item("Thin", body="<p>Four words only here.</p>", image=None))
        _, articles, report = await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS)
        assert "world/thin" in articles
        assert any("possible stub" in w for w in report["warnings"])

    async def test_two_stories_with_the_same_headline_in_one_feed_get_distinct_ids(self):
        fake = feeds_with(fx.item("Same", image=None) + fx.item("Same", image=None))
        # The cross-feed dedupe drops the second, which is the desired outcome:
        # inside one section an identical headline is the same cluster.
        _, articles, _ = await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS)
        assert len(articles) == 1

    async def test_section_order_follows_the_configured_reading_order(self):
        # Science listed first in the response map must still come second.
        reversed_feeds = [TWO_FEEDS[1], TWO_FEEDS[0]]
        fake = feeds_with(
            fx.item("W", image=None), fx.item("S", section="Science", image=None)
        )
        edition, _, _ = await B.build_edition(fake.fetch_bytes, fake.put_image, reversed_feeds)
        assert [s["slug"] for s in edition["sections"]] == ["science", "world"]

    async def test_no_more_than_one_request_per_url(self):
        fake = feeds_with(
            fx.item("One", image="https://img.example/a.png"),
            "",
            **{"https://img.example/a.png": fx.png(10, 10)},
        )
        await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS)
        assert len(fake.requests) == len(set(fake.requests))


class TestRealFeedConfiguration:
    """The configured feeds are data, but two properties of them are load-bearing."""

    def test_slugs_are_unique_and_stable_looking(self):
        slugs = [f["slug"] for f in F.FEEDS]
        assert slugs == ["world", "science", "usa", "boston"]
        assert len(set(slugs)) == len(slugs)

    def test_the_pipe_in_the_boston_url_is_percent_encoded(self):
        boston = next(f for f in F.FEEDS if f["slug"] == "boston")
        assert "|" not in boston["url"]
        assert "%7C" in boston["url"]


class TestUnchanged:
    """The early exit that makes the second daily cron firing cheap."""

    async def _fake(self):
        return feeds_with(
            fx.item("One", image="https://img.example/a.png"),
            "",
            **{"https://img.example/a.png": fx.png(400, 300)},
        )

    async def test_raises_before_any_picture_is_fetched(self):
        fake = await self._fake()

        async def is_current(date, built_from):
            return True

        with pytest.raises(B.Unchanged) as caught:
            await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS, is_current)

        assert caught.value.date == "2026-08-10"
        assert caught.value.built_from == BUILT
        assert fake.puts == []
        # Only the feeds were fetched: this is the whole point of the exit.
        assert all("feed" in url for url in fake.requests)
        assert len(fake.requests) == 2

    async def test_a_stale_stored_edition_rebuilds(self):
        fake = await self._fake()
        seen = {}

        async def is_current(date, built_from):
            seen["args"] = (date, built_from)
            return False

        edition, articles, _ = await B.build_edition(
            fake.fetch_bytes, fake.put_image, TWO_FEEDS, is_current
        )
        assert seen["args"] == ("2026-08-10", BUILT)
        assert edition["built_from"] == BUILT
        assert len(articles) == 1
        assert fake.puts  # the pictures were fetched this time

    async def test_timings_are_recorded_for_an_unattended_job(self):
        fake = await self._fake()
        _, _, report = await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS)
        for key in ("feeds_seconds", "images_seconds", "articles_seconds"):
            assert isinstance(report[key], float)


class TestPictureFloor:
    """What counts as a lead picture at all."""

    async def test_a_tracking_pixel_is_not_a_picture(self):
        fake = feeds_with(
            fx.item("Story"), "", **{"https://img.example/one.png": fx.png(1, 1)}
        )
        _, articles, report = await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS)
        assert fake.puts == []
        assert all(b["kind"] != "figure" for b in articles["world/story"]["blocks"])
        assert any("picture unavailable" in w for w in report["warnings"])

    async def test_an_icon_sized_graphic_is_rejected(self):
        fake = feeds_with(
            fx.item("Story"), "", **{"https://img.example/one.png": fx.png(64, 64)}
        )
        _, articles, _ = await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS)
        assert all(b["kind"] != "figure" for b in articles["world/story"]["blocks"])

    async def test_a_small_but_usable_photograph_is_kept(self):
        # Well under the old 512-byte floor once compressed, but a real picture.
        fake = feeds_with(
            fx.item("Story"), "", **{"https://img.example/one.png": fx.png(240, 120)}
        )
        _, articles, _ = await B.build_edition(fake.fetch_bytes, fake.put_image, TWO_FEEDS)
        figure = articles["world/story"]["blocks"][0]
        assert figure["kind"] == "figure"
        assert (figure["width"], figure["height"]) == (240, 120)
