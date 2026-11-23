//! Safe Markdown formatting for Canvas coursework exports.

use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::America::New_York;
use serde_json::Value;

use super::MARKER;

pub(super) fn render_readme(
    item: &Value,
    course_id: u64,
    item_id: u64,
    course: &str,
) -> Option<String> {
    let title = item.get("title").and_then(Value::as_str)?;
    let mut output = format!("{MARKER}\n# {}\n\n", markdown_inline(title));
    output.push_str(&format!(
        "- Course: {}\n- Canvas course ID: {course_id}\n- Canvas item ID: {item_id}\n",
        markdown_inline(course)
    ));
    append_optional_id(
        &mut output,
        "Canvas assignment ID",
        item,
        &["assignmentId", "assignment_id"],
    );
    append_optional_id(
        &mut output,
        "Canvas discussion topic ID",
        item,
        &["discussionTopicId", "discussion_topic_id"],
    );
    for (label, aliases) in [
        ("Due", &["dueAtUtc", "dueAt", "at"][..]),
        ("Created", &["createdAt"][..]),
        ("Updated", &["updatedAt"][..]),
        ("Posted", &["postedAt"][..]),
        ("Delayed post", &["delayedPostAt"][..]),
        ("Unlock", &["unlockAt"][..]),
        ("Lock", &["lockAt"][..]),
    ] {
        if let Some(value) = aliases
            .iter()
            .find_map(|key| item.get(*key).filter(|value| !value.is_null()))
        {
            output.push_str(&format!("- {label}: {}\n", timestamp(value)));
        }
    }
    output.push_str(&format!(
        "- Points: {}\n",
        display_value(item.get("points").or_else(|| item.get("pointsPossible")))
    ));
    output.push_str(&format!(
        "- Submission types: {}\n",
        display_list(
            item.get("submissionTypes")
                .or_else(|| item.get("submission_types"))
        )
    ));
    output.push_str(&format!(
        "- Require initial post: {}\n",
        display_value(
            item.get("requireInitialPost")
                .or_else(|| item.get("require_initial_post"))
        )
    ));
    append_references(&mut output, "Attachments", item.get("attachments"));
    append_references(
        &mut output,
        "Linked files",
        item.get("linkedFiles").or_else(|| item.get("linked_files")),
    );
    append_rubric(&mut output, item.get("rubric"));
    if let Some(description) = item.get("assignmentDetail").and_then(Value::as_str) {
        let description = description.trim();
        if !description.is_empty()
            && Some(description) != item.get("detail").and_then(Value::as_str).map(str::trim)
        {
            output.push_str("\n## Assignment description\n\n");
            output.push_str(&markdown_body(description));
            output.push('\n');
        }
    }
    output.push_str("\n## Body\n\n");
    if let Some(body) = item
        .get("detail")
        .and_then(Value::as_str)
        .filter(|body| !body.is_empty())
    {
        output.push_str(&markdown_body(body.trim()));
        output.push('\n');
    }
    Some(output)
}

fn append_optional_id(output: &mut String, label: &str, item: &Value, fields: &[&str]) {
    if let Some(id) = fields
        .iter()
        .find_map(|field| item.get(*field).filter(|value| !value.is_null()))
    {
        output.push_str(&format!("- {label}: {}\n", display_value(Some(id))));
    }
}

fn markdown_inline(value: &str) -> String {
    markdown_plain(value)
        .replace('`', "\\`")
        .replace('#', "\\#")
}

fn markdown_plain(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

fn markdown_body(value: &str) -> String {
    value
        .lines()
        .map(|line| match line.strip_prefix("> ") {
            Some(quote) => format!("> {}", markdown_plain(quote)),
            None => markdown_plain(line),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn display_value(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "Not supplied".into(),
        Some(Value::String(value)) => value.clone(),
        Some(value) => value.to_string(),
    }
}

fn display_list(value: Option<&Value>) -> String {
    match value {
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| display_value(Some(value)))
            .collect::<Vec<_>>()
            .join(", "),
        Some(Value::String(value)) => value.clone(),
        _ => "Not supplied".into(),
    }
}

fn timestamp(value: &Value) -> String {
    let Some(raw) = value.as_str() else {
        return display_value(Some(value));
    };
    if let Ok(parsed) = DateTime::parse_from_rfc3339(raw) {
        let utc = parsed.with_timezone(&Utc);
        let eastern = utc.with_timezone(&New_York);
        return format!(
            "{} ET / {} UTC",
            eastern.format("%Y-%m-%d %I:%M %p"),
            utc.format("%Y-%m-%d %H:%M:%S")
        );
    }
    if let Ok(parsed) = NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M") {
        if let Some(eastern) = New_York.from_local_datetime(&parsed).single() {
            return format!(
                "{} ET / {} UTC",
                eastern.format("%Y-%m-%d %I:%M %p"),
                eastern.with_timezone(&Utc).format("%Y-%m-%d %H:%M:%S")
            );
        }
    }
    if let Ok(parsed) = NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        return format!("{} ET / {} UTC (date only)", parsed, parsed);
    }
    raw.to_owned()
}

fn append_references(output: &mut String, label: &str, value: Option<&Value>) {
    let Some(values) = value
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty())
    else {
        return;
    };
    output.push_str(&format!("\n## {label}\n\n"));
    for reference in values {
        if let Some(object) = reference.as_object() {
            let name = object
                .get("name")
                .or_else(|| object.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("Canvas file");
            let id = object
                .get("id")
                .or_else(|| object.get("fileId"))
                .or_else(|| object.get("file_id"));
            output.push_str(&format!("- {}", markdown_inline(name)));
            if let Some(id) = id {
                output.push_str(&format!(" (ID {})", display_value(Some(id))));
            }
            output.push('\n');
        }
    }
}

fn append_rubric(output: &mut String, value: Option<&Value>) {
    let Some(rubric) = value.filter(|value| !value.is_null()) else {
        return;
    };
    output.push_str("\n## Rubric\n\n");
    if let Some(title) = rubric
        .get("settings")
        .and_then(|settings| settings.get("title"))
        .and_then(Value::as_str)
    {
        output.push_str(&format!("{}\n\n", markdown_inline(title)));
    }
    let criteria = rubric
        .get("criteria")
        .and_then(Value::as_array)
        .or_else(|| rubric.as_array());
    let Some(criteria) = criteria else {
        output.push_str("Rubric details are available in the imported item.\n");
        return;
    };
    for criterion in criteria {
        let label = criterion
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("Criterion");
        output.push_str(&format!("- **{}**", markdown_inline(label)));
        if let Some(points) = criterion.get("points") {
            output.push_str(&format!(" ({})", display_value(Some(points))));
        }
        output.push('\n');
        if let Some(detail) = criterion
            .get("longDescription")
            .or_else(|| criterion.get("long_description"))
            .and_then(Value::as_str)
        {
            output.push_str(&format!(
                "  {}\n",
                markdown_plain(&detail.replace('\n', "\n  "))
            ));
        }
        if let Some(ratings) = criterion.get("ratings").and_then(Value::as_array) {
            for rating in ratings {
                let label = rating
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("Rating");
                output.push_str(&format!("  - {}", markdown_inline(label)));
                if let Some(points) = rating.get("points") {
                    output.push_str(&format!(" ({})", display_value(Some(points))));
                }
                output.push('\n');
                if let Some(detail) = rating
                    .get("longDescription")
                    .or_else(|| rating.get("long_description"))
                    .and_then(Value::as_str)
                {
                    output.push_str(&format!("    {}\n", markdown_plain(detail)));
                }
            }
        }
    }
}
