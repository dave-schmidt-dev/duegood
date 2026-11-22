fn endpoint_path(course_id: u64, endpoint: &str) -> String {
    match endpoint {
        "announcements" => format!("/api/v1/announcements?context_codes[]=course_{course_id}&per_page=100"),
        "pages" => format!("/api/v1/courses/{course_id}/pages?include[]=body&per_page=100"),
        "modules" => format!("/api/v1/courses/{course_id}/modules?include[]=items&include[]=content_details&per_page=100"),
        "assignments" => format!("/api/v1/courses/{course_id}/assignments?include[]=submission&include[]=rubric&per_page=100"),
        "tabs" => format!("/api/v1/courses/{course_id}/tabs?per_page=100"),
        "assignment_groups" => format!("/api/v1/courses/{course_id}/assignment_groups?per_page=100"),
        "discussions" => format!("/api/v1/courses/{course_id}/discussion_topics?per_page=100"),
        "files" => format!("/api/v1/courses/{course_id}/files?per_page=100"),
        "folders" => format!("/api/v1/courses/{course_id}/folders?per_page=100"),
        _ => String::new(),
    }
}

fn project_endpoint(endpoint: &str, value: &Value) -> Result<Value, CaptureError> {
    let fields = match endpoint {
        "tabs" => TAB_FIELDS,
        "pages" => PAGE_FIELDS,
        "modules" => MODULE_FIELDS,
        "assignment_groups" => GROUP_FIELDS,
        "assignments" => ASSIGNMENT_FIELDS,
        "discussions" => DISCUSSION_FIELDS,
        "announcements" => ANNOUNCEMENT_FIELDS,
        "files" => FILE_FIELDS,
        "folders" => FOLDER_FIELDS,
        _ => return Err(CaptureError::InvalidCanvasResponse),
    };
    let mut projected = project_object(value, fields)?;
    if endpoint == "modules" {
        if let Some(items) = value.get("items").and_then(Value::as_array) {
            let items = items
                .iter()
                .map(|item| project_object(item, MODULE_ITEM_FIELDS).map(Value::Object))
                .collect::<Result<Vec<_>, _>>()?;
            projected.insert("items".into(), Value::Array(items));
        }
    } else if endpoint == "assignments" {
        projected.extend(
            crate::canvas_rubric::complete_assignment_rubric_fields(&clean_rubric_descriptions(
                value,
            )?)
            .map_err(|_| CaptureError::InvalidCanvasResponse)?,
        );
        if let Some(submission) = value.get("submission") {
            projected.insert(
                "submission".into(),
                if submission.is_null() {
                    Value::Null
                } else {
                    Value::Object(project_object(submission, SUBMISSION_FIELDS)?)
                },
            );
        }
    } else if endpoint == "discussions" {
        if let Some(source) = value.get("assignment") {
            if source.is_null() {
                projected.insert("assignment".into(), Value::Null);
            } else {
                let cleaned = clean_rubric_descriptions(source)?;
                let assignment = cleaned
                    .as_object()
                    .ok_or(CaptureError::InvalidCanvasResponse)?;
                let mut nested = Map::new();
                if let Some(id) = assignment.get("id") {
                    if !id.is_null() && id_of(Some(id)).is_none() {
                        return Err(CaptureError::InvalidCanvasResponse);
                    }
                    nested.insert("id".into(), id.clone());
                }
                nested.extend(
                    crate::canvas_rubric::assignment_rubric_fields(&cleaned)
                        .map_err(|_| CaptureError::InvalidCanvasResponse)?,
                );
                projected.insert("assignment".into(), Value::Object(nested));
            }
        }
    }
    Ok(Value::Object(projected))
}

fn clean_rubric_descriptions(value: &Value) -> Result<Value, CaptureError> {
    let mut cleaned = value.clone();
    let object = cleaned
        .as_object_mut()
        .ok_or(CaptureError::InvalidCanvasResponse)?;
    let Some(Value::Array(criteria)) = object.get_mut("rubric") else {
        return Ok(cleaned);
    };
    for criterion in criteria {
        let criterion = criterion
            .as_object_mut()
            .ok_or(CaptureError::InvalidCanvasResponse)?;
        for field in ["description", "long_description"] {
            clean_rubric_text(criterion.get_mut(field))?;
        }
        if let Some(Value::Array(ratings)) = criterion.get_mut("ratings") {
            for rating in ratings {
                let rating = rating
                    .as_object_mut()
                    .ok_or(CaptureError::InvalidCanvasResponse)?;
                for field in ["description", "long_description"] {
                    clean_rubric_text(rating.get_mut(field))?;
                }
            }
        }
    }
    Ok(cleaned)
}

fn clean_rubric_text(value: Option<&mut Value>) -> Result<(), CaptureError> {
    if let Some(Value::String(text)) = value {
        let (cleaned, truncated) = clean_message(text);
        if truncated {
            return Err(CaptureError::ResponseLimit);
        }
        *text = cleaned;
    }
    Ok(())
}

fn hydrate_discussion_assignment_rubric(
    topic: &mut Value,
    assignments: &mut [Value],
    assignment_indices: &BTreeMap<u64, usize>,
) -> Result<(), CaptureError> {
    let topic = topic
        .as_object_mut()
        .ok_or(CaptureError::InvalidCanvasResponse)?;
    let nested_id = topic
        .get("assignment")
        .and_then(Value::as_object)
        .and_then(|assignment| assignment.get("id"))
        .filter(|value| !value.is_null());
    let topic_id = topic.get("assignment_id").filter(|value| !value.is_null());
    if topic_id.is_none() && nested_id.is_none() {
        let rubric_evidence = topic
            .get("assignment")
            .and_then(Value::as_object)
            .is_some_and(|assignment| {
                ["rubric", "rubric_settings", "use_rubric_for_grading"]
                    .iter()
                    .any(|key| assignment.get(*key).is_some_and(|value| !value.is_null()))
            });
        return if rubric_evidence {
            Err(CaptureError::InvalidCanvasResponse)
        } else {
            Ok(())
        };
    }
    let topic_id = topic_id
        .map(|value| id_of(Some(value)).ok_or(CaptureError::InvalidCanvasResponse))
        .transpose()?;
    let nested_id = nested_id
        .map(|value| id_of(Some(value)).ok_or(CaptureError::InvalidCanvasResponse))
        .transpose()?;
    if topic_id.is_some() && nested_id.is_some() && topic_id != nested_id {
        return Err(CaptureError::InvalidCanvasResponse);
    }
    let assignment_id = topic_id
        .or(nested_id)
        .ok_or(CaptureError::InvalidCanvasResponse)?;
    let assignment_index = assignment_indices
        .get(&assignment_id)
        .copied()
        .ok_or(CaptureError::InvalidCanvasResponse)?;
    let canonical = assignments
        .get_mut(assignment_index)
        .and_then(Value::as_object_mut)
        .ok_or(CaptureError::InvalidCanvasResponse)?;

    let nested_value = topic
        .entry("assignment")
        .or_insert_with(|| Value::Object(Map::new()));
    if nested_value.is_null() {
        *nested_value = Value::Object(Map::new());
    }
    let nested = nested_value
        .as_object_mut()
        .ok_or(CaptureError::InvalidCanvasResponse)?;
    if nested.get("id").is_none_or(Value::is_null) {
        nested.insert("id".into(), Value::from(assignment_id));
    }
    let nested_rubric = nested.get("rubric").cloned();
    if canonical.get("rubric").is_none_or(Value::is_null)
        && nested_rubric
            .as_ref()
            .and_then(Value::as_array)
            .is_some_and(|criteria| !criteria.is_empty())
    {
        canonical.insert("rubric".into(), nested_rubric.unwrap_or(Value::Null));
    }
    for key in ["rubric_settings", "use_rubric_for_grading"] {
        let canonical_value = canonical.get(key).cloned();
        let nested_value = nested.get(key).cloned();
        if canonical_value.as_ref().is_none_or(Value::is_null)
            && nested_value.as_ref().is_some_and(|value| !value.is_null())
        {
            canonical.insert(key.into(), nested_value.clone().unwrap_or(Value::Null));
        }
    }
    for key in ["rubric", "rubric_settings", "use_rubric_for_grading"] {
        if let Some(value) = canonical.get(key) {
            nested.insert(key.into(), value.clone());
        }
    }
    Ok(())
}

fn index_assignments_by_id(assignments: &[Value]) -> Result<BTreeMap<u64, usize>, CaptureError> {
    let mut indices = BTreeMap::new();
    for (index, assignment) in assignments.iter().enumerate() {
        let id = id_of(assignment.get("id")).ok_or(CaptureError::InvalidCanvasResponse)?;
        if indices.insert(id, index).is_some() {
            return Err(CaptureError::InvalidCanvasResponse);
        }
    }
    Ok(indices)
}

/// Returns the in-memory-only URL Canvas supplied for a file download.
///
/// The caller must never persist this value: signed verifier query parameters are required for
/// the unauthenticated download, but the projected export stores only a query-stripped URL.
fn raw_file_download_url(value: &Value) -> Option<&str> {
    value
        .get("url")
        .or_else(|| value.get("download_url"))
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
}

fn project_object(value: &Value, fields: &[&str]) -> Result<Map<String, Value>, CaptureError> {
    let object = value
        .as_object()
        .ok_or(CaptureError::InvalidCanvasResponse)?;
    let mut projected = Map::new();
    for key in fields {
        if let Some(value) = object.get(*key) {
            projected.insert((*key).into(), sanitize_value(value, key));
        }
    }
    if fields == COURSE_FIELDS {
        if let Some(term) = object.get("term") {
            projected.insert(
                "term".into(),
                if term.is_null() {
                    Value::Null
                } else {
                    Value::Object(project_object(term, &["id", "name"])?)
                },
            );
        }
    }
    Ok(projected)
}

fn sanitize_value(value: &Value, field: &str) -> Value {
    match value {
        Value::String(text) => {
            let safe = redact(text);
            if field.ends_with("_url") || field == "url" || field == "avatar" {
                Value::from(strip_query(&safe))
            } else {
                Value::from(safe)
            }
        }
        Value::Array(values) => {
            Value::Array(values.iter().map(|v| sanitize_value(v, field)).collect())
        }
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), sanitize_value(value, key)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn request_record(response: &ApiResponse) -> Result<Value, CaptureError> {
    let url = strip_query(&response.safe_url);
    if !allowed_canvas_url(&url) {
        return Err(CaptureError::InvalidCanvasResponse);
    }
    Ok(json!({ "url": url, "status": response.status }))
}

fn allowed_canvas_url(url: &str) -> bool {
    if let Some(authority) = url
        .strip_prefix("https://")
        .and_then(|rest| rest.split('/').next())
    {
        return !authority.is_empty() && !authority.contains('@');
    }
    #[cfg(feature = "test-overrides")]
    if let Some(authority) = url
        .strip_prefix("http://")
        .and_then(|rest| rest.split('/').next())
    {
        return authority
            .parse::<std::net::SocketAddr>()
            .is_ok_and(|address| address.ip().is_loopback() && address.port() != 0);
    }
    false
}

fn course_url(api_url: &str, id: u64) -> Result<String, CaptureError> {
    let clean = strip_query(api_url);
    let (origin, _) = clean
        .split_once("/api/v1/")
        .ok_or(CaptureError::InvalidCanvasResponse)?;
    if !allowed_canvas_url(origin) {
        return Err(CaptureError::InvalidCanvasResponse);
    }
    Ok(format!("{origin}/courses/{id}"))
}

fn ensure_success(response: &ApiResponse) -> Result<(), CaptureError> {
    if (200..300).contains(&response.status) {
        Ok(())
    } else {
        Err(CaptureError::CanvasRequest)
    }
}

fn id_of(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    let id = value.as_u64().or_else(|| value.as_str()?.parse().ok())?;
    (id > 0).then_some(id)
}

fn validate_scope(scope: &CourseScope) -> Result<(), CaptureError> {
    if scope.canvas_course_id == 0
        || !safe_component(&scope.key)
        || !scope.folder.starts_with("classes/")
        || scope.folder.len() > 512
    {
        return Err(CaptureError::InvalidScope);
    }
    let parts: Vec<&str> = scope.folder.split('/').collect();
    if parts.len() < 2
        || parts[0] != "classes"
        || parts[1..].iter().any(|part| !safe_component(part))
        || parts.last().copied() != Some(scope.key.as_str())
    {
        return Err(CaptureError::InvalidScope);
    }
    Ok(())
}

fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}
