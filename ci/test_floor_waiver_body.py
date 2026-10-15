"""Tests for requiring queue-visible PR-body floor waivers."""

import unittest

from floor_waiver_body import missing_body_waivers, waiver_trailers


WAIVER = "Floor-waiver: test-deleted test/a.test.ts -- moved into the new suite"


class FloorWaiverBodyTests(unittest.TestCase):
    def test_collects_only_recognized_floor_waiver_lines(self):
        valid_threshold = "Floor-waiver: threshold-removed Coverage of changed lines -- verified elsewhere"
        messages = f"subject\n{WAIVER}\nFloor-waiver: incomplete\nFloor-waiver: typo-rule test/a.test.ts -- ignored\n{valid_threshold}\n"
        self.assertEqual(waiver_trailers(messages), {WAIVER, valid_threshold})

    def test_requires_exact_trailer_in_pr_body(self):
        self.assertEqual(missing_body_waivers(f"subject\n{WAIVER}\n", f"Details\n{WAIVER}\n"), [])
        self.assertEqual(missing_body_waivers(f"subject\n{WAIVER}\n", "Details\n"), [WAIVER])

    def test_one_body_trailer_cannot_cover_another_commit_waiver(self):
        other = "Floor-waiver: assertion-removed test/b.test.ts -- moved"
        self.assertEqual(missing_body_waivers(f"{WAIVER}\n{other}", WAIVER), [other])

    def test_duplicate_trailers_are_required_only_once(self):
        self.assertEqual(missing_body_waivers(f"{WAIVER}\n{WAIVER}", WAIVER), [])

    def test_wrapped_queue_trailer_still_parses(self):
        long_waiver = "Floor-waiver: test-deleted test/staging-workflow-secret-mapping.test.ts -- moved to docs"
        wrapped = "Floor-waiver: test-deleted test/staging-workflow-secret-mapping.test.ts\n-- moved to docs"
        self.assertEqual(waiver_trailers(wrapped), {long_waiver})
        self.assertEqual(missing_body_waivers(wrapped, long_waiver), [])
        self.assertEqual(missing_body_waivers(long_waiver, wrapped), [])

    def test_adjacent_wrapped_waivers_remain_separate(self):
        first = "Floor-waiver: test-deleted test/first.test.ts -- moved to docs"
        second = "Floor-waiver: assertion-removed test/second.test.ts -- assertion moved"
        third = "Floor-waiver: test-deleted test/staging-workflow-secret-mapping.test.ts -- moved to docs"
        wrapped = "\n".join(
            [
                "Floor-waiver: test-deleted test/first.test.ts",
                "-- moved to docs",
                "Floor-waiver: assertion-removed test/second.test.ts",
                "-- assertion moved",
                "Floor-waiver: test-deleted test/staging-workflow-secret-mapping.test.ts",
                "-- moved to docs",
            ]
        )
        self.assertEqual(waiver_trailers(wrapped), {first, second, third})

    def test_mid_path_wrap_strips_inserted_space(self):
        # A 72-column word-wrap can split inside a long path; real paths never
        # contain spaces, so the inserted space must not break the waiver.
        wrapped = "Floor-waiver: test-deleted test/staging-workflow-sec\nret-mapping.test.ts -- moved to docs"
        expected = "Floor-waiver: test-deleted test/staging-workflow-secret-mapping.test.ts -- moved to docs"
        self.assertEqual(waiver_trailers(wrapped), {expected})


if __name__ == "__main__":
    unittest.main()
