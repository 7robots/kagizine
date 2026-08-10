"""The parser and the sanitiser.

The sanitiser tests are the ones to keep honest: `Paragraph.html` and list items
are the only fields the reader hands to innerHTML, so anything that survives
`sanitise` runs in the browser.
"""

import fixtures as fx
import pytest

from kagi import feed as F


class TestSanitise:
    def test_keeps_allowed_inline_markup(self):
        assert F.sanitise("plain <b>bold</b> and <em>italic</em>") == (
            "plain <b>bold</b> and <em>italic</em>"
        )

    def test_escapes_text(self):
        assert F.sanitise("5 < 6 & 7 > 2") == "5 &lt; 6 &amp; 7 &gt; 2"

    def test_strips_disallowed_tags_but_keeps_their_text(self):
        assert F.sanitise("<div onmouseover=x>kept <small>small</small></div>") == (
            "kept <small>small</small>"
        )

    def test_drops_event_handlers_from_allowed_tags(self):
        out = F.sanitise('<a href="https://ok.example" onclick="evil()">good</a>')
        assert "onclick" not in out
        assert out.startswith('<a href="https://ok.example"')

    @pytest.mark.parametrize(
        "href",
        [
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox",
            "/relative/path",
            "mailto:someone@example.com",
        ],
    )
    def test_drops_links_with_unsafe_schemes(self, href):
        out = F.sanitise('<a href="%s">x</a>' % href)
        assert "<a" not in out
        assert out == "x"

    def test_external_links_open_away_from_the_reader(self):
        out = F.sanitise('<a href="https://ok.example">x</a>')
        assert 'target="_blank"' in out
        assert 'rel="noreferrer noopener"' in out

    def test_quotes_in_href_cannot_break_out_of_the_attribute(self):
        out = F.sanitise("<a href='https://x.example/\"onmouseover=\"evil()'>x</a>")
        assert "onmouseover" not in out or "&quot;" in out
        assert out.count("<a") <= 1

    def test_script_and_style_contents_are_discarded(self):
        assert F.sanitise("<script>alert(1)</script>tail") == "tail"
        assert F.sanitise("<style>p{color:red}</style>keep") == "keep"

    def test_unbalanced_markup_is_closed(self):
        assert F.sanitise("<p>unclosed <em>italic") == "unclosed <em>italic</em>"

    def test_crossed_tags_are_nested_properly(self):
        # <em>a<strong>b</em>c</strong> is not representable; the output must at
        # least be balanced, because innerHTML will otherwise reparent nodes.
        out = F.sanitise("<em>a<strong>b</em>c</strong>")
        assert out.count("<em>") == out.count("</em>")
        assert out.count("<strong>") == out.count("</strong>")

    def test_collapses_whitespace(self):
        assert F.sanitise("a  \n  b") == "a b"


class TestSlugAndCounts:
    @pytest.mark.parametrize(
        "title,expected",
        [
            ("Wildfires force evacuations", "wildfires-force-evacuations"),
            ("Athletics end Red Sox streaks!", "athletics-end-red-sox-streaks"),
            ("Häagen  —  Dazs", "haagen-dazs"),
            ("21.62C in June-July", "21-62c-in-june-july"),
            ("", "untitled"),
            ("!!!", "untitled"),
        ],
    )
    def test_slugify(self, title, expected):
        assert F.slugify(title) == expected

    def test_slugify_truncates_on_a_word_boundary(self):
        slug = F.slugify("a" * 30 + " " + "b" * 30 + " " + "c" * 30, limit=40)
        assert len(slug) <= 40
        assert not slug.endswith("-")

    def test_word_count_ignores_markup(self):
        assert F.word_count(F.strip_tags("<b>two</b> words")) == 2


class TestDates:
    def test_edition_date_takes_the_latest_build(self):
        assert (
            F.edition_date(
                [
                    "Mon, 10 Aug 2026 12:01:32 +0000",
                    "Mon, 10 Aug 2026 12:04:00 +0000",
                    "Sun, 09 Aug 2026 12:00:00 +0000",
                ]
            )
            == "2026-08-10"
        )

    def test_edition_date_ignores_unparseable_and_empty(self):
        assert F.edition_date(["", "not a date", "Mon, 10 Aug 2026 12:01:32 +0000"]) == (
            "2026-08-10"
        )
        assert F.edition_date([]) is None
        assert F.edition_date(["nonsense"]) is None

    def test_build_time_is_normalised_to_utc(self):
        # 08:01 Eastern is the same edition as 12:01 UTC, not the day before.
        assert F.edition_date(["Mon, 10 Aug 2026 08:01:00 -0400"]) == "2026-08-10"

    @pytest.mark.parametrize(
        "date,day",
        [
            ("2026-08-10", "Monday"),
            ("2026-08-09", "Sunday"),
            ("2026-01-01", "Thursday"),
            ("2026-02-28", "Saturday"),
            ("2024-02-29", "Thursday"),  # leap day
            ("2000-03-01", "Wednesday"),
        ],
    )
    def test_weekday(self, date, day):
        assert F.weekday(date) == day

    def test_edition_title(self):
        assert F.edition_title("2026-08-10") == "Kagi News, 10 August 2026"
        assert F.edition_title("2026-12-01") == "Kagi News, 1 December 2026"


class TestChannel:
    def test_parses_items_and_build_date(self):
        doc = fx.channel("World", "Mon, 10 Aug 2026 12:01:32 +0000", fx.item("One") + fx.item("Two"))
        channel = F.parse_channel(doc)
        assert channel["built_at"] == "Mon, 10 Aug 2026 12:01:32 +0000"
        assert len(channel["items"]) == 2

    def test_rejects_a_document_with_no_channel(self):
        with pytest.raises(ValueError):
            F.parse_channel(b"<rss version='2.0'></rss>")

    def test_item_fields_take_the_middle_category_as_the_subcategory(self):
        doc = fx.channel("World", "Mon, 10 Aug 2026 12:00:00 +0000", fx.item("T", sub="Ukraine War"))
        fields = F.item_fields(F.parse_channel(doc)["items"][0])
        assert fields["subcategory"] == "Ukraine War"
        assert fields["published"] == "2026-08-09T17:13:45+00:00"

    def test_lead_image_is_extracted_with_its_alt(self):
        doc = fx.channel("World", "Mon, 10 Aug 2026 12:00:00 +0000", fx.item("T"))
        fields = F.item_fields(F.parse_channel(doc)["items"][0])
        url, alt = F.lead_image_url(fields["description"])
        assert url == "https://img.example/one.png"
        assert alt == "A caption for the picture."

    def test_item_without_a_picture(self):
        doc = fx.channel("World", "Mon, 10 Aug 2026 12:00:00 +0000", fx.item("T", image=None))
        fields = F.item_fields(F.parse_channel(doc)["items"][0])
        assert F.lead_image_url(fields["description"]) == (None, "")


SECTION = {"slug": "world", "title": "World"}


def one_item(**kw) -> dict:
    doc = fx.channel("World", "Mon, 10 Aug 2026 12:00:00 +0000", fx.item("A story", **kw))
    return F.item_fields(F.parse_channel(doc)["items"][0])


class TestBuildArticle:
    def test_shape(self):
        article = F.build_article(one_item(extras=fx.FULL_BODY_EXTRAS), SECTION, None)
        assert article["id"] == "world/a-story"
        assert article["section_slug"] == "world"
        assert article["rubric"] == "Wildfires"
        assert article["dek"] is None
        kinds = [b["kind"] for b in article["blocks"]]
        assert kinds == ["p", "p", "h", "list", "h", "list"]
        assert [b["text"] for b in article["blocks"] if b["kind"] == "h"] == [
            "Highlights",
            "Perspectives",
        ]

    def test_block_ids_are_sequential(self):
        article = F.build_article(one_item(extras=fx.HIGHLIGHTS), SECTION, None)
        assert [b["id"] for b in article["blocks"]] == ["b0000", "b0001", "b0002", "b0003"]

    def test_sources_become_furniture_not_blocks(self):
        article = F.build_article(one_item(extras=fx.SOURCES), SECTION, None)
        assert all(b["kind"] != "h" for b in article["blocks"])
        assert [s["domain"] for s in article["sources"]] == ["one.example", "two.example"]
        assert article["sources"][0]["title"] == "Headline one"

    def test_duplicate_source_urls_are_dropped(self):
        article = F.build_article(one_item(extras=fx.SOURCES), SECTION, None)
        urls = [s["url"] for s in article["sources"]]
        assert len(urls) == len(set(urls))

    def test_perspective_links_survive_sanitising(self):
        article = F.build_article(one_item(extras=fx.PERSPECTIVES), SECTION, None)
        item = next(b for b in article["blocks"] if b["kind"] == "list")["items"][0]
        assert 'href="https://outlet.example/a"' in item

    def test_figure_leads_and_carries_its_dimensions(self):
        image = {"asset": "abc.png", "width": 1600, "height": 900, "alt": "A caption."}
        article = F.build_article(one_item(), SECTION, image)
        figure = article["blocks"][0]
        assert figure["kind"] == "figure"
        assert (figure["width"], figure["height"]) == (1600, 900)
        assert figure["caption"] == "A caption."
        assert figure["role"] == "hero"  # landscape breaks the measure

    def test_portrait_figures_stay_inside_the_measure(self):
        image = {"asset": "abc.png", "width": 900, "height": 1200, "alt": ""}
        article = F.build_article(one_item(), SECTION, image)
        assert article["blocks"][0]["role"] == "half"
        assert article["blocks"][0]["caption"] is None

    def test_word_count_covers_body_and_bullets(self):
        article = F.build_article(one_item(extras=fx.HIGHLIGHTS), SECTION, None)
        assert article["word_count"] > 8

    def test_rubric_falls_back_to_the_section(self):
        fields = dict(one_item(), subcategory="")
        assert F.build_article(fields, SECTION, None)["rubric"] == "World"

    def test_hostile_body_is_neutralised(self):
        body = (
            "<p>Real text.</p>"
            "<p><img src=x onerror=alert(1)>after</p>"
            "<p><a href='javascript:alert(1)'>click</a></p>"
        )
        article = F.build_article(one_item(body=body), SECTION, None)
        html_out = " ".join(b.get("html", "") for b in article["blocks"])
        assert "onerror" not in html_out
        assert "javascript:" not in html_out
        assert "Real text." in html_out


class TestCover:
    def test_cover_is_the_first_figure_in_reading_order(self):
        articles = {
            "world/a": {"blocks": [{"kind": "p", "html": "x"}]},
            "world/b": {"blocks": [{"kind": "figure", "asset": "second.jpg"}]},
            "science/c": {"blocks": [{"kind": "figure", "asset": "third.jpg"}]},
        }
        sections = [
            {"slug": "world", "article_ids": ["world/a", "world/b"]},
            {"slug": "science", "article_ids": ["science/c"]},
        ]
        assert F.choose_cover(sections, articles) == "second.jpg"

    def test_no_pictures_at_all(self):
        articles = {"world/a": {"blocks": [{"kind": "p", "html": "x"}]}}
        sections = [{"slug": "world", "article_ids": ["world/a"]}]
        assert F.choose_cover(sections, articles) is None
