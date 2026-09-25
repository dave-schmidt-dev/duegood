//! Bounded application of normalized iCal facts to the native coursework store.
//!
//! This module only applies observations to an existing authoritative store. It never bootstraps
//! a store, imports a legacy folder, removes rolling-window omissions, or writes student-owned
//! progress and notes.

use std::fmt;

use serde_json::Value;

use crate::canvas::CANVAS_ORIGIN;
use crate::config::{ReadLimits, COURSEWORK_FILE};
use crate::ical::{IcalNormalization, IcalNormalizeOptions, MAX_ICAL_EVENTS};
use crate::store::{
    atomic_write, node_json_bytes, sha256_hex, Store, StoreCondition, StoreError, StoreState,
};

#[path = "ical_apply_facts.rs"]
mod facts;
#[path = "ical_apply_merge.rs"]
mod merge;
#[path = "ical_apply_options.rs"]
mod options;
#[path = "ical_apply_refs.rs"]
mod refs;

use facts::{valid_timestamp, validate_text};
use merge::apply_to_document;
pub(crate) use options::normalization_options;

#[derive(Debug)]
pub(crate) enum IcalApplyError {
    Store(StoreError),
    /// Setup or owner promotion is still required; the native app store was not changed.
    StoreNotAuthoritative,
}

impl fmt::Display for IcalApplyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Store(error) => write!(formatter, "{error}"),
            Self::StoreNotAuthoritative => {
                formatter.write_str("the native coursework store is not authoritative")
            }
        }
    }
}

impl From<StoreError> for IcalApplyError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl From<std::io::Error> for IcalApplyError {
    fn from(error: std::io::Error) -> Self {
        Self::Store(StoreError::Io(error))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ApplyResult {
    pub version: String,
    pub added: usize,
    pub updated: usize,
    pub held: usize,
    pub parser_held: usize,
    pub removed: usize,
}

/// Applies normalized observations under the same OS write lock used by native coursework edits.
/// The helper passes a content-free UTC import completion timestamp for field provenance.
pub(crate) fn apply_normalization(
    store: &Store,
    options: &IcalNormalizeOptions,
    finished_at: &str,
    normalized: &IcalNormalization,
) -> Result<ApplyResult, IcalApplyError> {
    if normalized.deletions != 0 || normalized.observations.len() > MAX_ICAL_EVENTS {
        return Err(StoreError::Invalid("calendar normalization exceeds its limits").into());
    }
    validate_text(&options.institution, 160)?;
    if options.canvas_origin != CANVAS_ORIGIN {
        return Err(
            StoreError::Invalid("calendar origin is not the configured Canvas origin").into(),
        );
    }
    if !valid_timestamp(finished_at) {
        return Err(StoreError::Invalid("calendar import timestamp is invalid").into());
    }

    let _snapshot_lock = store.snapshot_lock()?;
    let _write_lock = store.write_lock()?;
    match store.condition()? {
        StoreCondition::Ready(manifest) if manifest.state == StoreState::Authoritative => {}
        StoreCondition::Empty | StoreCondition::Ready(_) => {
            return Err(IcalApplyError::StoreNotAuthoritative)
        }
        StoreCondition::Damaged(_) => {
            return Err(StoreError::Invalid("the native coursework store is unreadable").into())
        }
    }
    let current_options = options::normalization_options_locked(store)?;
    if !options::same_scope(options, &current_options) {
        return Err(StoreError::StoreChanged.into());
    }

    let prior = store
        .read_document(COURSEWORK_FILE, ReadLimits::PRODUCTION.max_document_bytes)?
        .ok_or(StoreError::Invalid(
            "the native coursework document is missing",
        ))?;
    let mut document: Value = serde_json::from_slice(&prior.bytes)
        .map_err(|_| StoreError::Invalid("the native coursework document is invalid"))?;
    let result = apply_to_document(&mut document, options, finished_at, normalized)?;
    if !result.changed {
        return Ok(ApplyResult {
            version: prior.digest,
            added: result.added,
            updated: result.updated,
            held: result.held,
            parser_held: normalized.held.len(),
            removed: 0,
        });
    }
    let bytes = node_json_bytes(&document);
    crate::snapshots::snapshot_before_refresh_locked(store, "ical-import")?;
    atomic_write(&store.store_dir().join(COURSEWORK_FILE), &bytes)?;
    Ok(ApplyResult {
        version: sha256_hex(&bytes),
        added: result.added,
        updated: result.updated,
        held: result.held,
        parser_held: normalized.held.len(),
        removed: 0,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ical::IcalCourseIdentity;
    use std::collections::HashMap;
    use std::fs;
    use std::time::{Duration, SystemTime};

    use serde_json::json;

    use crate::store::{create_private_dir, new_preview_manifest};
    use crate::testutil::TempRoot;

    fn store(state: &str) -> (TempRoot, Store) {
        let root = TempRoot::new("ical-apply");
        let store = Store::open(&root.path().to_path_buf(), Duration::from_millis(200)).unwrap();
        let directory = store.store_dir();
        create_private_dir(&directory, false).unwrap();
        let mut manifest = new_preview_manifest(1, 10, "synthetic", SystemTime::now());
        manifest["state"] = Value::String(state.into());
        atomic_write(
            &directory.join(crate::config::MANIFEST_FILE),
            &node_json_bytes(&manifest),
        )
        .unwrap();
        let mut coursework: Value = serde_json::from_slice(include_bytes!(
            "../../fixtures/local-coursework-contract.json"
        ))
        .unwrap();
        coursework["items"][0]["sourceReferences"] = json!([{
            "institution": "synthetic.institution.invalid",
            "course": "course-a",
            "source": "canvas",
            "id": "910001"
        }]);
        atomic_write(
            &directory.join(COURSEWORK_FILE),
            &node_json_bytes(&coursework),
        )
        .unwrap();
        atomic_write(
            &directory.join("courses.json"),
            br#"{"courses":[{"key":"course-a","canvasId":900001}]}"#,
        )
        .unwrap();
        (root, store)
    }

    fn options() -> IcalNormalizeOptions {
        IcalNormalizeOptions {
            institution: "synthetic.institution.invalid".into(),
            canvas_origin: "https://marymount.instructure.com".into(),
            courses: vec![IcalCourseIdentity {
                key: "course-a".into(),
                canvas_course_id: "900001".into(),
            }],
            verified_events: HashMap::new(),
            explicit_uid_mappings: HashMap::new(),
        }
    }

    fn observation(id: &str, local_id: &str, canvas_course_id: &str) -> Value {
        json!({
            "localId": local_id,
            "course": "course-a",
            "reference": {"institution":"synthetic.institution.invalid", "course":"course-a", "source":"ical", "id":format!("assignment:{id}")},
            "fields": {"kind":"assignment", "title":"Synthetic feed title", "at":"2030-01-29T23:59:00.000Z", "url":format!("https://marymount.instructure.com/courses/{canvas_course_id}/assignments/{id}")}
        })
    }

    fn normalized(observations: Vec<Value>) -> IcalNormalization {
        IcalNormalization {
            events: Vec::new(),
            observations,
            held: Vec::new(),
            deletions: 0,
        }
    }

    #[test]
    fn authoritative_apply_links_exact_canvas_id_preserves_personal_fields_and_never_deletes() {
        let (_root, store) = store("authoritative");
        let input = normalized(vec![observation("910001", "ical-generated-id", "900001")]);
        let outcome =
            apply_normalization(&store, &options(), "2030-01-10T12:00:00Z", &input).unwrap();
        assert_eq!(outcome.added, 0);
        assert_eq!(outcome.removed, 0);
        assert_eq!(outcome.held, 0);
        let bytes = store
            .read_document(COURSEWORK_FILE, ReadLimits::PRODUCTION.max_document_bytes)
            .unwrap()
            .unwrap()
            .bytes;
        let document: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(document["items"].as_array().unwrap().len(), 3);
        let item = document["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "course-a-canvas-910001")
            .unwrap();
        assert_eq!(item["done"], true);
        assert_eq!(item["doneAt"], "2030-01-09T15:05:00Z");
        assert_eq!(item["syntheticItemExtension"]["preserve"], "graded-item");
        assert_eq!(item["title"], "Synthetic Submitted Work");
        assert_eq!(item["at"], "2030-01-29T23:59:00.000Z");
        assert!(item["sourceReferences"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value["id"] == "assignment:910001"));
        assert_eq!(
            item["fieldObservations"]["title"]["alternatives"][0]["value"],
            "Synthetic feed title"
        );
        let first_bytes = bytes.clone();
        let repeated =
            apply_normalization(&store, &options(), "2030-01-10T12:00:00Z", &input).unwrap();
        assert_eq!(repeated.version, outcome.version);
        assert_eq!(
            store
                .read_document(COURSEWORK_FILE, ReadLimits::PRODUCTION.max_document_bytes)
                .unwrap()
                .unwrap()
                .bytes,
            first_bytes
        );
    }

    #[test]
    fn normalization_options_uses_course_map_and_refuses_to_guess_institution() {
        let (_root, store) = store("authoritative");
        let path = store.store_dir().join(COURSEWORK_FILE);
        let mut document: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        document["items"][0]
            .as_object_mut()
            .unwrap()
            .remove("sourceReferences");
        atomic_write(&path, &node_json_bytes(&document)).unwrap();
        assert!(matches!(
            normalization_options(&store),
            Err(IcalApplyError::Store(StoreError::Invalid(_)))
        ));

        let mut document: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        document["items"][0]["sourceReferences"] = json!([{
            "institution": "synthetic.institution.invalid",
            "course": "course-a",
            "source": "canvas",
            "id": "910001"
        }]);
        atomic_write(&path, &node_json_bytes(&document)).unwrap();
        let options = normalization_options(&store).unwrap();
        assert_eq!(options.institution, "synthetic.institution.invalid");
        assert_eq!(options.canvas_origin, CANVAS_ORIGIN);
        assert_eq!(options.courses.len(), 1);
        assert_eq!(options.courses[0].key, "course-a");
        assert_eq!(options.courses[0].canvas_course_id, "900001");
        assert!(options.verified_events.is_empty());
        assert!(options.explicit_uid_mappings.is_empty());
    }

    #[test]
    fn stale_feed_scope_is_rejected_without_touching_coursework() {
        let (_root, store) = store("authoritative");
        let path = store.store_dir().join(COURSEWORK_FILE);
        let before = fs::read(&path).unwrap();
        atomic_write(
            &store.store_dir().join("courses.json"),
            br#"{"courses":[{"key":"course-a","canvasId":900002}]}"#,
        )
        .unwrap();
        let input = normalized(vec![observation("910001", "ical-generated-id", "900001")]);
        assert!(matches!(
            apply_normalization(&store, &options(), "2030-01-10T12:00:00Z", &input),
            Err(IcalApplyError::Store(StoreError::StoreChanged))
        ));
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(!store.data_root().join("snapshots").exists());
    }

    #[test]
    fn multiple_exact_canvas_candidates_become_a_pending_hold_without_creating_an_item() {
        let (_root, store) = store("authoritative");
        let path = store.store_dir().join(COURSEWORK_FILE);
        let mut document: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let duplicate = document["items"][0].clone();
        let mut duplicate = duplicate;
        duplicate["id"] = Value::String("course-a-canvas-duplicate".into());
        duplicate
            .as_object_mut()
            .unwrap()
            .remove("sourceReferences");
        document["items"].as_array_mut().unwrap().push(duplicate);
        atomic_write(&path, &node_json_bytes(&document)).unwrap();

        let input = normalized(vec![observation("910001", "ical-generated-id", "900001")]);
        let outcome =
            apply_normalization(&store, &options(), "2030-01-10T12:00:00Z", &input).unwrap();
        assert_eq!(outcome.added, 0);
        assert_eq!(outcome.held, 1);
        let after: Value = serde_json::from_slice(
            &store
                .read_document(COURSEWORK_FILE, ReadLimits::PRODUCTION.max_document_bytes)
                .unwrap()
                .unwrap()
                .bytes,
        )
        .unwrap();
        assert_eq!(after["items"].as_array().unwrap().len(), 4);
        assert_eq!(
            after["pendingSourceLinks"][0]["reason"],
            "conflicting-match"
        );
        assert_eq!(
            after["pendingSourceLinks"][0]["candidateIds"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn generated_id_collision_with_a_personal_item_is_held_without_overwriting_it() {
        let (_root, store) = store("authoritative");
        let path = store.store_dir().join(COURSEWORK_FILE);
        let mut document: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        document["items"].as_array_mut().unwrap().push(json!({
            "id": "ical-generated-id",
            "course": "course-a",
            "source": "manual",
            "kind": "milestone",
            "title": "Owner-created synthetic milestone",
            "done": true,
            "notes": "Preserve this note",
            "manualExtension": {"preserve": true}
        }));
        atomic_write(&path, &node_json_bytes(&document)).unwrap();

        let input = normalized(vec![observation("999999", "ical-generated-id", "900001")]);
        let outcome =
            apply_normalization(&store, &options(), "2030-01-10T12:00:00Z", &input).unwrap();
        assert_eq!(outcome.added, 0);
        assert_eq!(outcome.held, 1);
        let after: Value = serde_json::from_slice(
            &store
                .read_document(COURSEWORK_FILE, ReadLimits::PRODUCTION.max_document_bytes)
                .unwrap()
                .unwrap()
                .bytes,
        )
        .unwrap();
        let owner_item = after["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "ical-generated-id")
            .unwrap();
        assert_eq!(owner_item["title"], "Owner-created synthetic milestone");
        assert_eq!(owner_item["done"], true);
        assert_eq!(owner_item["notes"], "Preserve this note");
        assert_eq!(owner_item["manualExtension"]["preserve"], true);
        assert_eq!(
            after["pendingSourceLinks"][0]["reason"],
            "conflicting-match"
        );
    }

    #[test]
    fn an_empty_or_preview_store_is_not_bootstrapped_or_mutated() {
        let root = TempRoot::new("ical-empty");
        let empty_store = Store::open(root.path(), Duration::from_millis(200)).unwrap();
        let input = normalized(vec![observation("910001", "ical-generated-id", "900001")]);
        assert!(matches!(
            apply_normalization(&empty_store, &options(), "2030-01-10T12:00:00Z", &input),
            Err(IcalApplyError::StoreNotAuthoritative)
        ));
        assert_eq!(empty_store.condition().unwrap(), StoreCondition::Empty);

        let (_preview_root, preview) = store("preview");
        assert!(matches!(
            apply_normalization(&preview, &options(), "2030-01-10T12:00:00Z", &input),
            Err(IcalApplyError::StoreNotAuthoritative)
        ));
        let before = preview
            .read_document(COURSEWORK_FILE, ReadLimits::PRODUCTION.max_document_bytes)
            .unwrap();
        assert!(before.is_some());
    }
}
