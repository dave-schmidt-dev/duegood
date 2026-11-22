const BUILTIN_LOCAL_FIELDS: &[&str] = &[
    "done",
    "doneAt",
    "discussionPostDone",
    "discussionRepliesDone",
    "manualGradeObservation",
];

fn declared_local_fields(item: &Value) -> Result<BTreeSet<String>, RefreshError> {
    let mut fields = BUILTIN_LOCAL_FIELDS
        .iter()
        .map(|field| (*field).to_owned())
        .collect::<BTreeSet<_>>();
    let Some(declared) = item.get("localOwnedFields") else {
        return Ok(fields);
    };
    let declared = declared.as_array().ok_or(RefreshError::InvalidCapture)?;
    for field in declared {
        let field = field
            .as_str()
            .filter(|field| {
                !field.is_empty()
                    && field.len() <= 80
                    && field
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                    && !matches!(
                        *field,
                        "id" | "course"
                            | "source"
                            | "canvasId"
                            | "sourceReferences"
                            | "fieldObservations"
                            | "localOwnedFields"
                            | "kind"
                            | "title"
                            | "at"
                            | "points"
                            | "url"
                            | "confidence"
                            | "flags"
                            | "detail"
                            | "assignmentGroupId"
                            | "assignmentGroupName"
                            | "assignmentGroupWeight"
                            | "submissionStatus"
                            | "submittedAt"
                            | "gradedAt"
                            | "grade"
                            | "score"
                    )
            })
            .ok_or(RefreshError::InvalidCapture)?;
        fields.insert(field.to_owned());
    }
    Ok(fields)
}

/// Removes only explicitly local-owned fields for the publish CAS comparison. Any concurrent
/// mutation to an unknown or source-owned field remains visible and aborts publication.
fn coursework_without_declared_local_state(value: &Value) -> Result<Value, RefreshError> {
    let mut copy = value.clone();
    for list_name in ["items", "archivedForecastItems"] {
        if let Some(items) = copy.get_mut(list_name).and_then(Value::as_array_mut) {
            for item in items {
                if let Some(object) = item.as_object_mut() {
                    let fields = declared_local_fields(&Value::Object(object.clone()))?;
                    for field in fields {
                        object.remove(&field);
                    }
                }
            }
        }
    }
    Ok(copy)
}

fn validate_capture(capture: &RefreshCapture) -> Result<(), RefreshError> {
    if !capture.coursework.is_object()
        || !capture
            .coursework
            .get("courses")
            .is_some_and(Value::is_array)
        || !capture.coursework.get("items").is_some_and(Value::is_array)
    {
        return Err(RefreshError::InvalidCapture);
    }
    let mut total = 0_u64;
    let mut entries = 1_u64;
    let coursework_bytes = node_json_bytes(&capture.coursework);
    if coursework_bytes.len() as u64 > ImportLimits::PRODUCTION.max_json_bytes {
        return Err(RefreshError::InvalidCapture);
    }
    total = total.saturating_add(coursework_bytes.len() as u64);
    let course_folders = capture_course_folders(&capture.coursework)?;
    for (name, bytes) in &capture.documents {
        if !allowed_capture_path(name, &course_folders)
            || matches!(
                name.as_str(),
                COURSEWORK_FILE | HISTORY_FILE | MANIFEST_FILE
            )
            || name.starts_with(&format!("{HISTORY_FILE}."))
            || name == "replace-journal.json"
            || name == "refresh-journal.json"
            || name.starts_with("snapshots/")
            || name.starts_with("backups/")
            || name.starts_with(STAGING_PREFIX)
        {
            return Err(RefreshError::InvalidCapture);
        }
        if bytes.len() as u64 > ImportLimits::PRODUCTION.max_file_bytes {
            return Err(RefreshError::InvalidCapture);
        }
        total = total.saturating_add(bytes.len() as u64);
        entries = entries.saturating_add(1);
        if total > ImportLimits::PRODUCTION.max_total_bytes
            || entries > ImportLimits::PRODUCTION.max_entries
        {
            return Err(RefreshError::InvalidCapture);
        }
    }
    Ok(())
}

fn capture_course_folders(coursework: &Value) -> Result<BTreeSet<String>, RefreshError> {
    let courses = coursework
        .get("courses")
        .and_then(Value::as_array)
        .ok_or(RefreshError::InvalidCapture)?;
    Ok(courses
        .iter()
        .filter_map(|course| {
            course
                .get("folder")
                .and_then(Value::as_str)
                .and_then(normalized_course_folder)
        })
        .collect())
}

fn allowed_capture_path(name: &str, courses: &BTreeSet<String>) -> bool {
    if !safe_relative_name(name) {
        return false;
    }
    if matches!(
        name,
        CONVERSATIONS_FILE | "canvas-profile.json" | "canvas-profile-avatar"
    ) {
        return true;
    }
    let parts: Vec<&str> = name.split('/').collect();
    if parts.len() < 3 || parts[0] != "classes" || !courses.contains(parts[1]) {
        return false;
    }
    match parts.as_slice() {
        ["classes", _, "coursework.md"] | ["classes", _, "canvas-course-report.md"] => true,
        ["classes", _, "materials", filename] => is_plain_basename(filename),
        ["classes", _, "canvas-export", filename]
            if matches!(
                *filename,
                "download-manifest.json"
                    | "request-manifest.json"
                    | "file-detail-omissions.json"
                    | "file-listing-status.json"
                    | "course-inventory.json"
                    | "canvas-course-report.md"
            ) =>
        {
            true
        }
        ["classes", _, "canvas-export", "api", filename] => matches!(
            *filename,
            "course.json"
                | "tabs.json"
                | "pages.json"
                | "modules.json"
                | "assignment_groups.json"
                | "assignments.json"
                | "discussions.json"
                | "announcements.json"
                | "files.json"
                | "folders.json"
        ),
        _ => false,
    }
}

fn safe_relative_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('\\')
        && !name.contains('\0')
        && !name.starts_with('/')
        && !name.ends_with('/')
        && name
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && Path::new(name)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn personal_key(item: &Value) -> Option<String> {
    item.get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

fn copy_personal_fields(
    source: &Value,
    target: &mut Map<String, Value>,
) -> Result<(), RefreshError> {
    for field in declared_local_fields(source)? {
        if let Some(value) = source.get(&field) {
            target.insert(field, value.clone());
        }
    }
    Ok(())
}

fn merge_personal_state(
    current: &Value,
    fresh: &Value,
    preserve_missing_items: bool,
) -> Result<Value, RefreshError> {
    let old_items = current
        .get("items")
        .and_then(Value::as_array)
        .ok_or(RefreshError::InvalidCapture)?;
    let mut result = fresh.clone();
    let fresh_archived_keys: BTreeSet<String> = result
        .get("archivedForecastItems")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(personal_key)
        .collect();
    let fresh_items = result
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .ok_or(RefreshError::InvalidCapture)?;
    let old_by_key: BTreeMap<String, Value> = old_items
        .iter()
        .filter_map(|item| personal_key(item).map(|key| (key, item.clone())))
        .collect();
    let mut fresh_keys = BTreeSet::new();
    let mut preserved_item_keys = BTreeSet::new();
    for item in fresh_items.iter_mut() {
        let Some(key) = personal_key(item) else {
            continue;
        };
        fresh_keys.insert(key.clone());
        if let (Some(previous), Some(target)) = (old_by_key.get(&key), item.as_object_mut()) {
            copy_personal_fields(previous, target)?;
        }
    }
    for item in old_items {
        let Some(key) = personal_key(item) else {
            continue;
        };
        if !fresh_keys.contains(&key) {
            if preserve_missing_items {
                fresh_keys.insert(key.clone());
                preserved_item_keys.insert(key);
                fresh_items.push(item.clone());
            } else if item.get("source").and_then(Value::as_str) != Some("canvas")
                && !fresh_archived_keys.contains(&key)
            {
                fresh_keys.insert(key);
                fresh_items.push(item.clone());
            }
        }
    }

    let current_archived = current
        .get("archivedForecastItems")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let target = result.as_object_mut().ok_or(RefreshError::InvalidCapture)?;
    let archived = target
        .entry("archivedForecastItems")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or(RefreshError::InvalidCapture)?;
    if !preserved_item_keys.is_empty() {
        archived.retain(|item| {
            personal_key(item).map_or(true, |key| !preserved_item_keys.contains(&key))
        });
    }
    let mut archived_keys: BTreeSet<String> = archived.iter().filter_map(personal_key).collect();
    for item in archived.iter_mut() {
        if let Some(key) = personal_key(item) {
            if let (Some(previous), Some(object)) = (old_by_key.get(&key), item.as_object_mut()) {
                copy_personal_fields(previous, object)?;
            }
        }
    }
    for item in old_items
        .iter()
        .filter(|item| item.get("source").and_then(Value::as_str) == Some("canvas"))
    {
        if let Some(key) = personal_key(item) {
            if !fresh_keys.contains(&key) && archived_keys.insert(key) {
                archived.push(item.clone());
            }
        }
    }
    for item in current_archived {
        if let Some(key) = personal_key(&item) {
            if !fresh_keys.contains(&key) && archived_keys.insert(key) {
                archived.push(item);
            }
        } else if !archived.contains(&item) {
            archived.push(item);
        }
    }
    Ok(result)
}

fn personal_state_changed(before: &Value, after: &Value) -> Result<bool, RefreshError> {
    fn index(value: &Value) -> BTreeMap<String, Value> {
        let mut indexed = BTreeMap::new();
        for list_name in ["items", "archivedForecastItems"] {
            for item in value
                .get(list_name)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(key) = personal_key(item) {
                    indexed.insert(key, item.clone());
                }
            }
        }
        indexed
    }

    let before = index(before);
    let after = index(after);
    for (key, old) in &before {
        if let Some(new) = after.get(key) {
            for field in declared_local_fields(old)? {
                if old.get(&field) != new.get(&field) {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

fn update_staged_activity(
    path: &Path,
    source_complete: bool,
    personal_reapplied: bool,
) -> Result<(), StoreError> {
    let bytes = read_capped(path, ReadLimits::PRODUCTION.max_document_bytes)?
        .ok_or(StoreError::Invalid("refresh history is missing"))?;
    let mut history: Value = serde_json::from_slice(&bytes)
        .map_err(|_| StoreError::Invalid("refresh history is malformed"))?;
    let events = history
        .get_mut("events")
        .and_then(Value::as_array_mut)
        .ok_or(StoreError::Invalid("refresh history is malformed"))?;
    let event = events
        .last_mut()
        .and_then(Value::as_object_mut)
        .ok_or(StoreError::Invalid("refresh history event is missing"))?;
    event.insert("sourceComplete".to_owned(), Value::Bool(source_complete));
    event.insert(
        "personalStateReapplied".to_owned(),
        Value::Bool(personal_reapplied),
    );
    if personal_reapplied {
        event.insert(
            "notice".to_owned(),
            Value::String("personal_state_reapplied".to_owned()),
        );
    } else {
        event.remove("notice");
    }
    if !source_complete {
        event.insert("status".to_owned(), Value::String("incomplete".to_owned()));
    }
    let changes = event
        .get_mut("changes")
        .and_then(Value::as_array_mut)
        .ok_or(StoreError::Invalid("refresh history changes are malformed"))?;
    if personal_reapplied {
        changes.insert(
            0,
            serde_json::json!({
                "kind": "notice",
                "title": "Personal progress kept",
                "detail": "Changes made during this refresh were preserved."
            }),
        );
    }
    if !source_complete {
        changes.retain(|change| change.get("kind").and_then(Value::as_str) != Some("removed"));
        event
            .get_mut("summary")
            .and_then(Value::as_object_mut)
            .ok_or(StoreError::Invalid("refresh history summary is malformed"))?
            .insert("removed".to_owned(), Value::from(0));
    }
    atomic_write(path, &node_json_bytes(&history))?;
    Ok(())
}

fn write_staged_document(root: &Path, name: &str, bytes: &[u8]) -> Result<(), StoreError> {
    let relative = Path::new(name);
    let mut parent = root.to_path_buf();
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(StoreError::InvalidName);
        };
        parent.push(name);
        if components.peek().is_some() {
            match fs::symlink_metadata(&parent) {
                Ok(metadata) if metadata.file_type().is_dir() => {}
                Ok(_) => return Err(StoreError::Invalid("staged parent is not a directory")),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    create_private_dir(&parent, false)?;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
    atomic_write(&parent, bytes)?;
    #[cfg(target_os = "macos")]
    if name.split('/').nth(2) == Some("materials") {
        use std::os::unix::fs::OpenOptionsExt;
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&parent)?;
        crate::resources_save::quarantine_saved_copy(&file)?;
    }
    Ok(())
}

fn stage_generation(
    source_generation: &Path,
    staging: &Path,
    capture: &RefreshCapture,
    coursework: &Value,
    baseline: &Value,
    event: Value,
    now: SystemTime,
    progress: &mut dyn FnMut(ExportProgress),
) -> Result<(), StoreError> {
    crate::export::copy_tree(source_generation, staging, true, progress)?;
    if let Some(recovered) =
        history::recover_missed_grade_history(&staging.join(HISTORY_FILE), baseline, now)?
    {
        history::append_event(&staging.join(HISTORY_FILE), recovered, now)?;
    }
    for (name, bytes) in &capture.documents {
        write_staged_document(staging, name, bytes)?;
    }
    write_staged_document(staging, COURSEWORK_FILE, &node_json_bytes(coursework))?;
    history::append_event(&staging.join(HISTORY_FILE), event, now)?;
    fsync_dir(staging)?;
    Ok(())
}

