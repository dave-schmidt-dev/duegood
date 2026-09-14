"""Tests for package utilities only. The proposed hosted application is not implemented."""
import copy
from dataclasses import replace
import json
from pathlib import Path
import sys
import unittest
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
from check_package import check, validate_fixture
from estimate_usage import Assumptions, estimate

class EstimateTests(unittest.TestCase):
    def test_basic_five_course_sync(self):
        r = estimate(Assumptions())
        self.assertEqual(r['canvas_calls_per_sync'],7)
        self.assertEqual(r['worker_requests_per_day'],3200)
        self.assertEqual(r['d1_rows_written_per_day'],6400)
    def test_three_course_sync(self):
        self.assertEqual(estimate(Assumptions(courses=3))['canvas_calls_per_sync'],5)
    def test_cached_course_list_and_valid_token(self):
        a=Assumptions(course_pages=0,token_refresh_calls=0)
        self.assertEqual(estimate(a)['canvas_calls_per_sync'],5)
    def test_default_canvas_page_size_cost(self):
        a=Assumptions(assignments_per_course=50,page_size=10)
        self.assertEqual(estimate(a)['assignment_pages_per_sync'],25)
    def test_round_up_pagination(self):
        self.assertEqual(estimate(Assumptions(assignments_per_course=101))['assignment_pages_per_sync'],10)
    def test_empty_courses_still_need_request(self):
        a=Assumptions(assignments_per_course=0,changed_assignments_per_sync=0)
        self.assertEqual(estimate(a)['assignment_pages_per_sync'],5)
    def test_canvas_not_counted_as_incoming_worker(self):
        a=Assumptions()
        r1=estimate(a); r2=estimate(replace(a,enrichment_calls=30,retry_calls=4))
        self.assertEqual(r1['worker_requests_per_day'],r2['worker_requests_per_day'])
        self.assertEqual(r2['canvas_calls_per_sync']-r1['canvas_calls_per_sync'],34)
    def test_staging_is_accounted(self):
        r1=estimate(Assumptions()); r2=estimate(Assumptions(staging_writes_per_sync=200))
        self.assertEqual(r2['d1_rows_written_per_day']-r1['d1_rows_written_per_day'],80000)
    def test_naive_thousand_student_rewrites(self):
        r=estimate(Assumptions(students=1000))
        self.assertEqual(r['naive_assignment_rewrites_per_day_before_overhead'],800000)
    def test_account_shared_overhead(self):
        r=estimate(Assumptions(students=0,other_account_requests=99,other_account_writes=88))
        self.assertEqual(r['worker_requests_per_day'],99)
        self.assertEqual(r['d1_rows_written_per_day'],88)
    def test_invalid_inputs(self):
        for value in [Assumptions(page_size=0),Assumptions(students=-1),
                      Assumptions(syncs=float('nan')),Assumptions(syncs=float('inf')),
                      Assumptions(changed_assignments_per_sync=201),Assumptions(students=True)]:
            with self.subTest(value=value),self.assertRaises(ValueError):
                estimate(value)
    def test_allowance_warning(self):
        r=estimate(Assumptions(students=10000))
        self.assertTrue(any('reaches or exceeds' in w for w in r['warnings']))

class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.f=json.loads((ROOT/'fixtures/planner-scenarios.json').read_text())
    def test_fixture_is_valid(self):
        validate_fixture(self.f)
    def test_checkpoint_unknown_parent_rejected(self):
        self.f['normalizedCheckpoints'][0]['parentAssignmentId']='does-not-exist'
        with self.assertRaises(ValueError): validate_fixture(self.f)
    def test_duplicate_assignment_rejected(self):
        self.f['assignments'].append(copy.deepcopy(self.f['assignments'][0]))
        with self.assertRaises(ValueError): validate_fixture(self.f)
    def test_live_origin_rejected(self):
        self.f['institution']['canvasOrigin']='https://real-campus.example'
        with self.assertRaises(ValueError): validate_fixture(self.f)
    def test_omitted_and_null_fields_distinct(self):
        self.assertNotIn('submission',self.f['assignments'][2])
        self.assertIsNone(self.f['assignments'][3]['submission'])
    def test_package_checks(self):
        self.assertEqual(check(ROOT),[])

if __name__ == '__main__': unittest.main()
