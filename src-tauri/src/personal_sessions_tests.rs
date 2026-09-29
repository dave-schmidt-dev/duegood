use std::fs;
use std::io::Cursor;
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};

use super::*;
use crate::reconcile::{reconcile_coursework, CourseAssignments};
use crate::store::{atomic_write, create_private_dir, new_preview_manifest, node_json_bytes};
use crate::testutil::TempRoot;

const COURSE: u64 = 900_001;
const TERM: &str = "Synthetic current term";
const ZONE: &str = "America/New_York";
const NOTE_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn seeded_store() -> (TempRoot, Store) {
    let root = TempRoot::new("personal-sessions");
    let store = Store::open(root.path(), Duration::from_millis(25)).unwrap();
    let directory = store.store_dir();
    create_private_dir(&directory, false).unwrap();
    let mut manifest = new_preview_manifest(1, 1, "synthetic", SystemTime::now());
    manifest["state"] = json!("authoritative");
    atomic_write(
        &directory.join(crate::config::MANIFEST_FILE),
        &node_json_bytes(&manifest),
    )
    .unwrap();
    atomic_write(
        &directory.join(COURSEWORK_FILE),
        &node_json_bytes(&coursework()),
    )
    .unwrap();
    (root, store)
}

fn coursework() -> Value {
    json!({
        "schema":1, "term":TERM, "timezone":ZONE,
        "courses":[
            {"key":"synthetic-a","canvasCourseId":COURSE,"unknownCourseField":{"retain":true}},
            {"key":"synthetic-b","canvasCourseId":null}
        ],
        "items":[
            {"id":"manual-existing","course":"synthetic-a","kind":"milestone","source":"manual","notes":"Synthetic local note","done":true,"unknownItemField":{"retain":true}},
            {"id":"canvas-existing","course":"synthetic-a","kind":"assignment","source":"canvas","canvasId":44,"done":false}
        ],
        "unknownDocumentField":{"retain":true}
    })
}

fn request_for(document: &Value) -> PersonalSessionRequest {
    let digest = crate::store::sha256_hex(&node_json_bytes(document));
    parse(&json!({
        "expectedVersion":digest, "canvasCourseId":COURSE, "term":TERM, "timeZone":ZONE,
        "sessions":[{
            "date":"2030-01-14", "startTime":"18:00", "endTime":"20:30",
            "localNoteSha256":NOTE_HASH
        }]
    }))
}

fn parse(value: &Value) -> PersonalSessionRequest {
    let bytes = serde_json::to_vec(value).unwrap();
    read_personal_session_request(Cursor::new(bytes)).unwrap()
}

fn document(store: &Store) -> Value {
    let bytes = store
        .read_document(COURSEWORK_FILE, 1024 * 1024)
        .unwrap()
        .unwrap()
        .bytes;
    serde_json::from_slice(&bytes).unwrap()
}

fn assert_rejected_without_write(
    store: &Store,
    request: &PersonalSessionRequest,
    expected_code: &str,
) {
    let path = store.store_dir().join(COURSEWORK_FILE);
    let before = fs::read(&path).unwrap();
    assert_eq!(
        apply_personal_sessions(store, request, &mut |_| {})
            .unwrap_err()
            .code(),
        expected_code
    );
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn adds_manual_session_with_explicit_clock_and_note_hash_provenance() {
    let (_root, store) = seeded_store();
    let before = document(&store);
    let mut progress = Vec::new();
    let result = apply_personal_sessions(&store, &request_for(&before), &mut |phase| {
        progress.push(phase)
    })
    .unwrap();
    assert_eq!(
        result,
        PersonalSessionResult {
            added: 1,
            updated: 0,
            unchanged: false
        }
    );
    assert_eq!(progress, vec![PersonalSessionProgress::Writing]);
    let after = document(&store);
    let item = after["items"].as_array().unwrap().last().unwrap();
    assert_eq!(item["kind"], "session");
    assert_eq!(item["source"], "manual");
    assert_eq!(item["course"], "synthetic-a");
    assert_eq!(item["at"], "2030-01-14T18:00:00-05:00");
    assert_eq!(item["endsAt"], "2030-01-14T20:30:00-05:00");
    assert_eq!(item["personalSession"]["canvasCourseId"], COURSE);
    assert_eq!(item["personalSession"]["term"], TERM);
    assert_eq!(item["personalSession"]["localNoteSha256"], NOTE_HASH);
    assert_eq!(
        after["unknownDocumentField"],
        before["unknownDocumentField"]
    );
    assert_eq!(after["items"][0], before["items"][0]);
}

#[test]
fn replay_preserves_personal_fields_and_exact_bytes() {
    let (_root, store) = seeded_store();
    let before = document(&store);
    apply_personal_sessions(&store, &request_for(&before), &mut |_| {}).unwrap();
    let path = store.store_dir().join(COURSEWORK_FILE);
    let first = fs::read(&path).unwrap();
    let mut first_value: Value = serde_json::from_slice(&first).unwrap();
    let session = first_value["items"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap();
    session["done"] = json!(true);
    session["notes"] = json!("Synthetic personal note");
    session["unknownPersonalField"] = json!({"retain":true});
    atomic_write(&path, &node_json_bytes(&first_value)).unwrap();
    let personal_bytes = fs::read(&path).unwrap();
    let result = apply_personal_sessions(&store, &request_for(&first_value), &mut |_| {}).unwrap();
    assert_eq!(
        result,
        PersonalSessionResult {
            added: 0,
            updated: 0,
            unchanged: true
        }
    );
    assert_eq!(fs::read(&path).unwrap(), personal_bytes);
}

#[test]
fn corrected_owner_clock_updates_the_same_session_and_retains_progress_and_notes() {
    let (_root, store) = seeded_store();
    let before = document(&store);
    apply_personal_sessions(&store, &request_for(&before), &mut |_| {}).unwrap();
    let path = store.store_dir().join(COURSEWORK_FILE);
    let mut personal: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let original_id = personal["items"].as_array().unwrap().last().unwrap()["id"].clone();
    let session = personal["items"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap();
    session["done"] = json!(true);
    session["notes"] = json!("Synthetic personal note");
    atomic_write(&path, &node_json_bytes(&personal)).unwrap();
    let mut corrected = request_for(&personal);
    corrected.sessions[0].end_time = "21:00".into();
    let result = apply_personal_sessions(&store, &corrected, &mut |_| {}).unwrap();
    assert_eq!(
        result,
        PersonalSessionResult {
            added: 0,
            updated: 1,
            unchanged: false
        }
    );
    let corrected_document = document(&store);
    let corrected_session = corrected_document["items"]
        .as_array()
        .unwrap()
        .last()
        .unwrap();
    assert_eq!(corrected_session["id"], original_id);
    assert_eq!(corrected_session["endsAt"], "2030-01-14T21:00:00-05:00");
    assert_eq!(corrected_session["done"], true);
    assert_eq!(corrected_session["notes"], "Synthetic personal note");
}

#[test]
fn stale_version_and_held_native_lock_do_not_modify_the_document() {
    let (_root, store) = seeded_store();
    let original = document(&store);
    let stale = request_for(&original);
    let mut changed = original.clone();
    changed["unknownDocumentField"] = json!({"changed":true});
    atomic_write(
        &store.store_dir().join(COURSEWORK_FILE),
        &node_json_bytes(&changed),
    )
    .unwrap();
    assert_eq!(
        apply_personal_sessions(&store, &stale, &mut |_| {})
            .unwrap_err()
            .code(),
        "VERSION_CONFLICT"
    );
    let request = request_for(&changed);
    let held = store.write_lock().unwrap();
    assert_eq!(
        apply_personal_sessions(&store, &request, &mut |_| {})
            .unwrap_err()
            .code(),
        "STORE_UNAVAILABLE"
    );
    drop(held);
    assert_eq!(document(&store), changed);
}

#[test]
fn rejects_bad_course_term_time_zone_dates_and_duplicate_dates() {
    let (_root, store) = seeded_store();
    let original = document(&store);
    let mut cases = Vec::new();
    let mut bad_course = request_for(&original);
    bad_course.canvas_course_id = COURSE + 1;
    cases.push(bad_course);
    let mut bad_term = request_for(&original);
    bad_term.term = "Other synthetic term".into();
    cases.push(bad_term);
    let mut bad_zone = request_for(&original);
    bad_zone.time_zone = "Eastern".into();
    cases.push(bad_zone);
    let mut wrong_valid_zone = request_for(&original);
    wrong_valid_zone.time_zone = "Europe/London".into();
    cases.push(wrong_valid_zone);
    let mut bad_date = request_for(&original);
    bad_date.sessions[0].date = "2030-02-30".into();
    cases.push(bad_date);
    let mut duplicate = request_for(&original);
    duplicate.sessions.push(SessionInput {
        date: "2030-01-14".into(),
        start_time: "19:00".into(),
        end_time: "20:00".into(),
        local_note_sha256: NOTE_HASH.into(),
    });
    cases.push(duplicate);
    for request in cases {
        assert!(apply_personal_sessions(&store, &request, &mut |_| {}).is_err());
        assert_eq!(document(&store), original);
    }
}

#[test]
fn source_refresh_retains_manual_session() {
    let (_root, store) = seeded_store();
    let before = document(&store);
    apply_personal_sessions(&store, &request_for(&before), &mut |_| {}).unwrap();
    let added = document(&store);
    let refreshed = reconcile_coursework(
        &added,
        &[CourseAssignments {
            key: "synthetic-a".into(),
            groups: vec![],
            assignments: vec![],
        }],
        SystemTime::now(),
    )
    .unwrap();
    let session = added["items"].as_array().unwrap().last().unwrap();
    assert!(refreshed["items"].as_array().unwrap().contains(session));
}

#[test]
fn stdin_is_bounded_and_rejects_unknown_or_multiple_payloads() {
    assert_eq!(
        read_personal_session_request(Cursor::new(b"{}".as_slice()))
            .unwrap_err()
            .code(),
        "INVALID_INPUT"
    );
    let mut oversized = vec![b' '; (MAX_REQUEST_BYTES + 1) as usize];
    assert_eq!(
        read_personal_session_request(Cursor::new(&mut oversized))
            .unwrap_err()
            .code(),
        "INPUT_TOO_LARGE"
    );
    assert_eq!(
        read_personal_session_request(Cursor::new(b"{}\n{}\n".as_slice()))
            .unwrap_err()
            .code(),
        "INVALID_INPUT"
    );
}

#[test]
fn accepts_only_exact_canonical_native_canvas_id_forms() {
    assert_eq!(course_canvas_id(Some(&json!(COURSE))), Some(COURSE));
    assert_eq!(
        course_canvas_id(Some(&json!(COURSE.to_string()))),
        Some(COURSE)
    );
    for value in [json!("0900001"), json!("0"), json!(-1), json!(null)] {
        assert_eq!(course_canvas_id(Some(&value)), None);
    }
}

#[test]
fn rejects_unsupported_schema_and_non_authoritative_store_without_write() {
    let (_root, store) = seeded_store();
    let original = document(&store);
    let mut unsupported = original.clone();
    unsupported["schema"] = json!(2);
    atomic_write(
        &store.store_dir().join(COURSEWORK_FILE),
        &node_json_bytes(&unsupported),
    )
    .unwrap();
    assert_rejected_without_write(&store, &request_for(&unsupported), "COURSEWORK_INVALID");

    atomic_write(
        &store.store_dir().join(COURSEWORK_FILE),
        &node_json_bytes(&original),
    )
    .unwrap();
    let manifest_path = store.store_dir().join(crate::config::MANIFEST_FILE);
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["state"] = json!("preview");
    atomic_write(&manifest_path, &node_json_bytes(&manifest)).unwrap();
    assert_rejected_without_write(&store, &request_for(&original), "STORE_NOT_AUTHORITATIVE");
}

#[test]
fn rejects_foreign_session_identity_or_provenance_without_write() {
    let (_root, store) = seeded_store();
    let original = document(&store);
    apply_personal_sessions(&store, &request_for(&original), &mut |_| {}).unwrap();
    let added = document(&store);
    let mut wrong_kind = added.clone();
    wrong_kind["items"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["kind"] = json!("assignment");
    let mut wrong_source = added.clone();
    wrong_source["items"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["source"] = json!("canvas");
    let mut wrong_course = added.clone();
    wrong_course["items"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["course"] = json!("synthetic-b");
    let mut wrong_provenance = added.clone();
    wrong_provenance["items"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["personalSession"]["timeZone"] = json!("Europe/London");
    for candidate in [wrong_kind, wrong_source, wrong_course, wrong_provenance] {
        atomic_write(
            &store.store_dir().join(COURSEWORK_FILE),
            &node_json_bytes(&candidate),
        )
        .unwrap();
        assert_rejected_without_write(&store, &request_for(&candidate), "SESSION_ID_CONFLICT");
    }
}

#[test]
fn dst_gaps_and_folds_reject_without_write() {
    let (_root, store) = seeded_store();
    let original = document(&store);
    for (date, start, end) in [
        ("2030-03-10", "02:15", "03:30"),
        ("2030-11-03", "01:15", "02:30"),
    ] {
        let mut request = request_for(&original);
        request.sessions[0].date = date.into();
        request.sessions[0].start_time = start.into();
        request.sessions[0].end_time = end.into();
        assert_rejected_without_write(&store, &request, "INVALID_INPUT");
    }
}

#[test]
fn empty_oversized_and_reversed_session_ranges_reject_without_write() {
    let (_root, store) = seeded_store();
    let original = document(&store);
    let mut empty = request_for(&original);
    empty.sessions.clear();
    assert_rejected_without_write(&store, &empty, "INVALID_INPUT");

    let mut oversized = request_for(&original);
    oversized.sessions = (0..=MAX_SESSIONS)
        .map(|_| SessionInput {
            date: "2030-01-14".into(),
            start_time: "18:00".into(),
            end_time: "20:30".into(),
            local_note_sha256: NOTE_HASH.into(),
        })
        .collect();
    assert_rejected_without_write(&store, &oversized, "INVALID_INPUT");

    let mut reversed = request_for(&original);
    reversed.sessions[0].start_time = "20:30".into();
    reversed.sessions[0].end_time = "18:00".into();
    assert_rejected_without_write(&store, &reversed, "INVALID_INPUT");
}
