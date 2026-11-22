struct CapturedCourse {
    groups: Vec<Value>,
    assignments: Vec<Value>,
    source_complete: bool,
}

fn capture_course(
    api: &CanvasApi,
    downloads: &DownloadClient,
    prior: &RefreshPrior,
    scope: &CourseScope,
    captured_at: &str,
    documents: &mut BTreeMap<String, Vec<u8>>,
    total_bytes: &mut usize,
    progress: &mut dyn FnMut(RefreshProgress),
    request_count: &mut u64,
) -> Result<CapturedCourse, CaptureError> {
    let id = scope.canvas_course_id;
    let mut requests = Map::new();

    before_request(progress, *request_count, *total_bytes);
    let response_result = api.get_json(&format!(
        "/api/v1/courses/{id}?include[]=syllabus_body&include[]=term"
    ));
    *request_count += 1;
    after_request(progress, *request_count, *total_bytes);
    let response = response_result.map_err(|_| CaptureError::CanvasRequest)?;
    ensure_success(&response)?;
    let course = project_object(&response.body, COURSE_FIELDS)?;
    if id_of(course.get("id")) != Some(id) {
        return Err(CaptureError::InvalidCanvasResponse);
    }
    let source_url = course_url(&response.safe_url, id)?;
    requests.insert(
        "course".into(),
        Value::Array(vec![request_record(&response)?]),
    );

    let mut exports: BTreeMap<String, Value> = BTreeMap::new();
    exports.insert("course".to_owned(), Value::Object(course.clone()));
    let mut groups = Vec::new();
    let mut assignments = Vec::new();
    let mut raw_files = Vec::new();
    let mut source_complete = true;
    let mut linked_file_ids = BTreeSet::new();
    let mut file_listing_omission = None;
    let mut file_listing_partial = false;
    let mut file_omissions = Vec::new();
    let origin = source_url
        .split_once("/courses/")
        .map(|(origin, _)| origin)
        .ok_or(CaptureError::InvalidCanvasResponse)?;
    for endpoint in ENDPOINTS {
        let pages = get_pages_with_progress(
            api,
            &endpoint_path(id, endpoint),
            progress,
            request_count,
            *total_bytes,
        );
        let pages = match pages {
            Ok(pages) => pages,
            Err((CanvasError::HttpStatus(status @ (401 | 403 | 404)), 0))
                if endpoint == "files" =>
            {
                file_listing_omission = Some(if status == 403 {
                    "forbidden-optional"
                } else if status == 404 {
                    "not-found"
                } else {
                    "locked"
                });
                Vec::new()
            }
            Err((CanvasError::HttpStatus(403 | 404), _)) if endpoint == "files" => {
                return Err(CaptureError::CanvasRequest);
            }
            Err((
                CanvasError::RequestFailed
                | CanvasError::PageLimitExceeded
                | CanvasError::ItemLimitExceeded
                | CanvasError::ResponseTooLarge,
                _,
            )) if endpoint == "files" => {
                file_listing_partial = true;
                source_complete = false;
                Vec::new()
            }
            Err(_) => return Err(CaptureError::CanvasRequest),
        };
        if pages.len() > MAX_PAGES {
            return Err(CaptureError::ResponseLimit);
        }
        let mut records = Vec::new();
        let mut request_records = Vec::with_capacity(pages.len());
        let assignment_indices = if endpoint == "discussions" {
            Some(index_assignments_by_id(&assignments)?)
        } else {
            None
        };
        for page in &pages {
            ensure_success(page)?;
            request_records.push(request_record(page)?);
            let rows = page
                .body
                .as_array()
                .ok_or(CaptureError::InvalidCanvasResponse)?;
            if records.len().saturating_add(rows.len()) > MAX_ITEMS {
                return Err(CaptureError::ResponseLimit);
            }
            for row in rows {
                if endpoint == "files" {
                    raw_files.push(row.clone());
                }
                if matches!(
                    endpoint,
                    "assignments" | "discussions" | "pages" | "announcements"
                ) {
                    linked_file_ids.extend(collect_linked_file_ids(row, id, origin)?);
                }
                let mut projected = project_endpoint(endpoint, row)?;
                if endpoint == "assignment_groups" {
                    groups.push(projected.clone());
                } else if endpoint == "assignments" {
                    assignments.push(projected.clone());
                } else if endpoint == "discussions" {
                    hydrate_discussion_assignment_rubric(
                        &mut projected,
                        &mut assignments,
                        assignment_indices
                            .as_ref()
                            .ok_or(CaptureError::InvalidCanvasResponse)?,
                    )?;
                }
                records.push(projected);
            }
        }
        requests.insert(endpoint.into(), Value::Array(request_records));
        exports.insert(endpoint.into(), Value::Array(records));
    }

    exports.insert("assignments".into(), Value::Array(assignments.clone()));

    let topics = exports
        .get("discussions")
        .and_then(Value::as_array)
        .ok_or(CaptureError::InvalidCanvasResponse)?;
    capture_discussion_file_references(
        api,
        id,
        origin,
        topics,
        &mut linked_file_ids,
        &mut requests,
        &mut file_omissions,
        progress,
        request_count,
        *total_bytes,
        &mut source_complete,
    )?;

    let mut files = exports
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .ok_or(CaptureError::InvalidCanvasResponse)?;
    if (!file_listing_partial && files.len() > MAX_FILES) || raw_files.len() != files.len() {
        return Err(CaptureError::ResponseLimit);
    }
    let listed_file_count = files.len();
    source_complete &= append_linked_file_metadata(
        api,
        id,
        &linked_file_ids,
        &mut raw_files,
        &mut files,
        &mut requests,
        &mut file_omissions,
        progress,
        request_count,
        *total_bytes,
    )?;
    if files.len() > MAX_FILES + MAX_LINKED_FILE_DETAILS || raw_files.len() != files.len() {
        return Err(CaptureError::ResponseLimit);
    }
    exports.insert("files".into(), Value::Array(files.clone()));
    let mut download_manifest = Vec::new();
    for (index, raw_file) in raw_files.iter().enumerate() {
        let file = files
            .get(index)
            .ok_or(CaptureError::InvalidCanvasResponse)?;
        let file_id = id_of(file.get("id")).ok_or(CaptureError::InvalidCanvasResponse)?;
        let is_linked_file = linked_file_ids.contains(&file_id);
        let file_name = file
            .get("display_name")
            .or_else(|| file.get("filename"))
            .and_then(Value::as_str)
            .map(|s| clean(s, 240))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("canvas-file-{file_id}"));
        let size64 = file
            .get("size")
            .and_then(Value::as_u64)
            .ok_or(CaptureError::InvalidCanvasResponse)?;
        let Ok(size) = usize::try_from(size64) else {
            if index < listed_file_count && !is_linked_file {
                return Err(CaptureError::ResponseLimit);
            }
            source_complete = false;
            download_manifest.push(json!({
                "id":file_id,"name":file_name,"size":size64,
                "status":"omitted","reason":"detail-budget"
            }));
            continue;
        };
        if size > MAX_FILE_BYTES {
            if index < listed_file_count && !is_linked_file {
                return Err(CaptureError::ResponseLimit);
            }
            source_complete = false;
            download_manifest.push(json!({
                "id":file_id,"name":file_name,"size":size,
                "status":"omitted","reason":"detail-budget"
            }));
            continue;
        }
        let updated_at = file.get("updated_at").cloned().unwrap_or(Value::Null);
        let url = raw_file_download_url(raw_file).ok_or(CaptureError::InvalidCanvasResponse)?;
        let reusable_material = if is_linked_file {
            None
        } else {
            reusable(prior, scope, file_id, &file_name, size, &updated_at)?
        };
        if let Some((filename, material)) = reusable_material {
            if total_bytes.saturating_add(material.len()) > MAX_TOTAL_BYTES {
                if index < listed_file_count {
                    return Err(CaptureError::OutputLimit);
                }
                source_complete = false;
                download_manifest.push(json!({
                    "id":file_id,"name":file_name,"size":size,
                    "updated_at":updated_at,"status":"omitted","reason":"capture-budget"
                }));
                continue;
            }
            *total_bytes += material.len();
            documents.insert(format!("{}/materials/{filename}", scope.folder), material);
            download_manifest.push(json!({
                "id":file_id,"name":file_name,"filename":filename,"size":size,
                "updated_at":updated_at,"status":"reused"
            }));
            continue;
        }

        before_request(progress, *request_count, *total_bytes);
        let result = downloads.download_file(url);
        *request_count += 1;
        after_request(progress, *request_count, *total_bytes);
        let body = match result {
            Ok(body) => body,
            Err(DownloadError::HttpStatus(status @ (401 | 403 | 404))) => {
                if index < listed_file_count && !is_linked_file {
                    return Err(CaptureError::Download);
                }
                download_manifest.push(json!({
                    "id":file_id,
                    "name":file_name,
                    "size":size,
                    "status":"omitted",
                    "reason": match status {
                        401 => "locked",
                        403 => "forbidden-optional",
                        _ => "not-found"
                    }
                }));
                continue;
            }
            Err(_) => {
                if index < listed_file_count && !is_linked_file {
                    return Err(CaptureError::Download);
                }
                source_complete = false;
                download_manifest.push(json!({
                    "id":file_id,"name":file_name,"size":size,
                    "status":"omitted","reason":"request-failed"
                }));
                continue;
            }
        };
        if body.status != 200 {
            if index < listed_file_count && !is_linked_file {
                return Err(CaptureError::Download);
            }
            source_complete = false;
            download_manifest.push(json!({
                "id":file_id,"name":file_name,"size":size,
                "status":"omitted","reason":"request-failed"
            }));
            continue;
        }
        if body.bytes.len() > MAX_FILE_BYTES
            || total_bytes.saturating_add(body.bytes.len()) > MAX_TOTAL_BYTES
            || body.bytes.len() != size
        {
            if index < listed_file_count && !is_linked_file {
                return Err(CaptureError::ResponseLimit);
            }
            source_complete = false;
            download_manifest.push(json!({
                "id":file_id,"name":file_name,"size":size,
                "status":"omitted","reason":"capture-budget"
            }));
            continue;
        }
        if body.bytes.is_empty() && size == 0 {
            download_manifest.push(json!({
                "id":file_id,"name":file_name,"size":size,
                "updated_at":updated_at,"status":"omitted","reason":"empty"
            }));
            continue;
        }
        let declared_content_type = file
            .get("content_type")
            .or_else(|| file.get("content-type"))
            .and_then(Value::as_str);
        let verified_content_type = if is_linked_file {
            match crate::capture_media::verify_content_type_with_declared_type(
                body.content_type.as_deref(),
                declared_content_type,
                &body.bytes[..body.bytes.len().min(2048)],
            ) {
                Ok(content_type) => Some(content_type),
                Err(_) => {
                    source_complete = false;
                    download_manifest.push(json!({
                        "id":file_id,"name":file_name,"size":size,
                        "updated_at":updated_at,"status":"omitted","reason":"request-failed"
                    }));
                    continue;
                }
            }
        } else {
            None
        };
        let reported_name = disposition_name(body.content_disposition.as_deref())
            .or_else(|| {
                file.get("filename")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| file_name.clone());
        let filename = material_name(file_id, &reported_name)?;
        let linked_sha256 =
            verified_content_type.map(|_| format!("{:x}", Sha256::digest(&body.bytes)));
        *total_bytes += body.bytes.len();
        documents.insert(format!("{}/materials/{filename}", scope.folder), body.bytes);
        let mut receipt = json!({
            "id":file_id,"name":file_name,"filename":filename,"size":size,
            "updated_at":updated_at,"status":"downloaded"
        });
        if let (Some(content_type), Some(sha256)) = (verified_content_type, linked_sha256) {
            receipt["contentType"] = Value::from(content_type);
            receipt["sha256"] = Value::from(sha256);
            receipt["sourceAuthenticity"] = Value::from("unverified");
        }
        download_manifest.push(receipt);
    }

    let export_dir = format!("{}/canvas-export", scope.folder);
    for endpoint in [
        "course",
        "tabs",
        "pages",
        "modules",
        "assignment_groups",
        "assignments",
        "discussions",
        "announcements",
        "files",
        "folders",
    ] {
        if endpoint == "files" && file_listing_partial {
            continue;
        }
        put_json(
            documents,
            &format!("{export_dir}/api/{endpoint}.json"),
            exports
                .get(endpoint)
                .ok_or(CaptureError::InvalidCanvasResponse)?,
            total_bytes,
        )?;
    }
    put_json(
        documents,
        &format!("{export_dir}/download-manifest.json"),
        &Value::Array(download_manifest.clone()),
        total_bytes,
    )?;
    put_json(
        documents,
        &format!("{export_dir}/file-detail-omissions.json"),
        &Value::Array(file_omissions.clone()),
        total_bytes,
    )?;
    let listing_status = if let Some(reason) = file_listing_omission {
        json!({ "status": "omitted", "reason": reason })
    } else if file_listing_partial {
        json!({ "status": "incomplete", "reason": "request-failed" })
    } else {
        json!({ "status": "complete" })
    };
    put_json(
        documents,
        &format!("{export_dir}/file-listing-status.json"),
        &listing_status,
        total_bytes,
    )?;
    put_json(
        documents,
        &format!("{export_dir}/request-manifest.json"),
        &Value::Object(requests),
        total_bytes,
    )?;
    let mut inventory = Map::new();
    inventory.insert("capturedAt".into(), Value::from(captured_at));
    inventory.insert(
        "linkedFileCount".into(),
        Value::from(files.len().saturating_sub(listed_file_count)),
    );
    inventory.insert(
        "fileListingPartial".into(),
        Value::from(file_listing_partial),
    );
    if let Some(reason) = file_listing_omission {
        inventory.insert("filesListingOmission".into(), json!({ "reason": reason }));
    }
    inventory.insert(
        "linkedFileCount".into(),
        Value::from(files.len().saturating_sub(listed_file_count)),
    );
    for endpoint in [
        "course",
        "tabs",
        "pages",
        "modules",
        "assignment_groups",
        "assignments",
        "discussions",
        "announcements",
        "files",
        "folders",
    ] {
        inventory.insert(
            endpoint.into(),
            exports
                .get(endpoint)
                .cloned()
                .ok_or(CaptureError::InvalidCanvasResponse)?,
        );
    }
    if !file_listing_partial {
        put_json(
            documents,
            &format!("{export_dir}/course-inventory.json"),
            &Value::Object(inventory),
            total_bytes,
        )?;
    }
    let report = report(
        &course,
        &source_url,
        captured_at,
        &exports,
        &download_manifest,
    );
    put_text(
        documents,
        &format!("{}/canvas-course-report.md", scope.folder),
        report.as_bytes(),
        total_bytes,
    )?;

    Ok(CapturedCourse {
        groups,
        assignments,
        source_complete,
    })
}

include!("capture_projection.rs");

fn strip_query(value: &str) -> String {
    value[..value.find(['?', '#']).unwrap_or(value.len())].to_string()
}

fn redact(input: &str) -> String {
    const KEYS: [&str; 8] = [
        "access_token",
        "access-token",
        "authorization",
        "bearer",
        "token",
        "password",
        "secret",
        "auth",
    ];
    let lower = input.to_ascii_lowercase();
    let mut cursor = 0usize;
    let mut output = String::with_capacity(input.len());
    while cursor < input.len() {
        let mut matched_end = None;
        for key in KEYS {
            if lower[cursor..].starts_with(key) {
                let end = cursor + key.len();
                let before_ok = cursor == 0
                    || (!lower.as_bytes()[cursor - 1].is_ascii_alphanumeric()
                        && lower.as_bytes()[cursor - 1] != b'_');
                let after_ok = end == lower.len()
                    || (!lower.as_bytes()[end].is_ascii_alphanumeric()
                        && lower.as_bytes()[end] != b'_');
                if before_ok && after_ok {
                    matched_end = Some(end);
                    break;
                }
            }
        }
        let Some(key_end) = matched_end else {
            let ch = input[cursor..].chars().next().expect("valid cursor");
            output.push(ch);
            cursor += ch.len_utf8();
            continue;
        };
        output.push_str(&input[cursor..key_end]);
        let mut start = key_end;
        while start < input.len() && input.as_bytes()[start].is_ascii_whitespace() {
            start += 1;
        }
        if start >= input.len() || !matches!(input.as_bytes()[start], b'=' | b':') {
            cursor = key_end;
            continue;
        }
        output.push('=');
        start += 1;
        while start < input.len() && input.as_bytes()[start].is_ascii_whitespace() {
            start += 1;
        }
        output.push_str("[redacted]");
        cursor = start;
        while cursor < input.len() {
            let ch = input[cursor..].chars().next().expect("valid cursor");
            if ch.is_whitespace() || matches!(ch, ',' | ';' | '&' | '#' | '<' | '>') {
                break;
            }
            cursor += ch.len_utf8();
        }
    }
    output
}

fn reusable(
    prior: &RefreshPrior,
    scope: &CourseScope,
    file_id: u64,
    name: &str,
    size: usize,
    updated_at: &Value,
) -> Result<Option<(String, Vec<u8>)>, CaptureError> {
    let folder = scope
        .folder
        .strip_prefix("classes/")
        .ok_or(CaptureError::InvalidScope)?;
    let Some(manifest) = prior.download_manifest_for(folder) else {
        return Ok(None);
    };
    let Some(entries) = manifest.as_array() else {
        return Ok(None);
    };
    for entry in entries {
        if id_of(entry.get("id")) != Some(file_id)
            || entry.get("sourceAuthenticity").and_then(Value::as_str) == Some("unverified")
            || entry.get("name").and_then(Value::as_str) != Some(name)
            || entry.get("size").and_then(Value::as_u64) != Some(size as u64)
            || entry.get("updated_at").unwrap_or(&Value::Null) != updated_at
            || !matches!(
                entry.get("status").and_then(Value::as_str),
                Some("downloaded" | "reused")
            )
        {
            continue;
        }
        let Some(filename) = entry.get("filename").and_then(Value::as_str) else {
            continue;
        };
        if !filename.starts_with(&format!("{file_id}-")) || !safe_filename(filename) {
            continue;
        }
        if prior.material_size_for(folder, filename) != Some(size as u64) {
            continue;
        }
        let bytes = prior
            .read_material_bytes(folder, filename)
            .map_err(|_| CaptureError::Download)?;
        let Some(bytes) = bytes else { continue };
        if bytes.len() == size {
            return Ok(Some((filename.to_owned(), bytes)));
        }
    }
    Ok(None)
}

fn safe_filename(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 240
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
}

fn material_name(id: u64, source: &str) -> Result<String, CaptureError> {
    let name = source.rsplit(['/', '\\']).next().unwrap_or(source).trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(':')
        || name.chars().any(char::is_control)
    {
        return Err(CaptureError::InvalidCanvasResponse);
    }
    let prefix = format!("{id}-");
    let name: String = name
        .chars()
        .take(240usize.saturating_sub(prefix.len()))
        .collect();
    let name = name.trim();
    if name.is_empty() {
        return Err(CaptureError::InvalidCanvasResponse);
    }
    Ok(format!("{prefix}{name}"))
}

fn disposition_name(value: Option<&str>) -> Option<String> {
    for part in value?.split(';').skip(1) {
        let Some((key, raw)) = part.trim().split_once('=') else {
            continue;
        };
        if key.eq_ignore_ascii_case("filename*") {
            let raw = raw.trim().trim_matches('"');
            let value = raw.split_once("''").map(|(_, tail)| tail).unwrap_or(raw);
            if let Some(decoded) = percent_decode(value) {
                return Some(decoded);
            }
        } else if key.eq_ignore_ascii_case("filename") {
            return Some(raw.trim().trim_matches('"').replace("\\\"", "\""));
        }
    }
    None
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let digit = |byte: u8| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            };
            output.push(digit(*bytes.get(index + 1)?)? * 16 + digit(*bytes.get(index + 2)?)?);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

fn report(
    course: &Map<String, Value>,
    source: &str,
    captured_at: &str,
    exports: &BTreeMap<String, Value>,
    manifest: &[Value],
) -> String {
    let name = course
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Canvas course");
    let name = name
        .replace('|', "\\|")
        .replace('\n', " ")
        .replace('\r', " ");
    let count = |key: &str| {
        exports
            .get(key)
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
    };
    let available = manifest
        .iter()
        .filter(|v| {
            matches!(
                v.get("status").and_then(Value::as_str),
                Some("downloaded" | "reused")
            )
        })
        .count();
    let downloaded = manifest
        .iter()
        .filter(|v| v.get("status").and_then(Value::as_str) == Some("downloaded"))
        .count();
    let reused = manifest
        .iter()
        .filter(|v| v.get("status").and_then(Value::as_str) == Some("reused"))
        .count();
    format!(
        "# {name}\n\nCaptured: {captured_at}\nSource: {source}\n\n## Inventory\n\n- Pages: {}\n- Modules: {}\n- Assignment groups: {}\n- Assignments: {}\n- Discussions: {}\n- Announcements: {}\n- Course files: {}\n- Material files available: {available}/{}\n- Downloaded this refresh: {downloaded}\n- Reused unchanged files: {reused}\n",
        count("pages"), count("modules"), count("assignment_groups"), count("assignments"),
        count("discussions"), count("announcements"), count("files"), count("files")
    )
}
