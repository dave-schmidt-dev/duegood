"""Tests for synthetic package fixtures and public-source checks."""
import copy
import json
from pathlib import Path
import sys
import unittest
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
from check_package import check, validate_canvas_phase1_fixture, validate_fixture

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

class CanvasPhase1FixtureTests(unittest.TestCase):
    def setUp(self):
        self.f=json.loads((ROOT/'fixtures/canvas-phase1.json').read_text())
    def test_fixture_is_valid(self):
        validate_canvas_phase1_fixture(self.f)
    def test_not_synthetic_rejected(self):
        self.f['synthetic']=False
        with self.assertRaises(ValueError): validate_canvas_phase1_fixture(self.f)
    def test_live_origin_rejected(self):
        self.f['institution']['canvasOrigin']='https://real-campus.example'
        with self.assertRaises(ValueError): validate_canvas_phase1_fixture(self.f)
    def test_duplicate_course_id_rejected(self):
        self.f['courses'].append(copy.deepcopy(self.f['courses'][0]))
        with self.assertRaises(ValueError): validate_canvas_phase1_fixture(self.f)
    def test_duplicate_assignment_id_rejected(self):
        self.f['assignments'].append(copy.deepcopy(self.f['assignments'][0]))
        with self.assertRaises(ValueError): validate_canvas_phase1_fixture(self.f)
    def test_unknown_course_reference_rejected(self):
        self.f['assignments'][0]['courseId']='does-not-exist'
        with self.assertRaises(ValueError): validate_canvas_phase1_fixture(self.f)
    def test_missing_submission_state_rejected(self):
        self.f['assignments']=[a for a in self.f['assignments'] if a['id']!='50004']
        with self.assertRaises(ValueError): validate_canvas_phase1_fixture(self.f)
    def test_profiles_must_scale(self):
        self.f['profiles']['large']['courseCount']=1
        with self.assertRaises(ValueError): validate_canvas_phase1_fixture(self.f)
    def test_unsafe_course_id_must_exceed_max_safe_integer(self):
        self.f['unsafeCourseId']='1'
        with self.assertRaises(ValueError): validate_canvas_phase1_fixture(self.f)
    def test_known_null_and_not_returned_distinct(self):
        by_id={a['id']:a for a in self.f['assignments']}
        self.assertIsNone(by_id['50002']['submission'])
        self.assertNotIn('submission',by_id['50003'])
    def test_package_checks(self):
        self.assertEqual(check(ROOT),[])

if __name__ == '__main__': unittest.main()
