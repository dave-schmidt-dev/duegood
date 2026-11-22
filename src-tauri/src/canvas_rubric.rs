//! Strict projection for Canvas rubric data.

use serde_json::{Map, Value};

use crate::browser_projection::{sanitize::sanitize_value, ProjectionError};

#[cfg(test)]
#[path = "canvas_rubric_tests.rs"]
mod tests;

/// Projects only the rubric fields supported by the capture schema.
///
/// Missing rubric data becomes an explicit `null`, which records that the assignment has no
/// rubric in a complete assignment response. Unknown Canvas fields never pass through.
pub(crate) fn assignment_rubric_fields(
    assignment: &Value,
) -> Result<Map<String, Value>, ProjectionError> {
    assignment_rubric_fields_with_absence(assignment, false)
}

/// Projects the fields from a successful complete assignment response.
///
/// A missing `rubric` key is known absence only for the direct reader after requesting it. Older
/// browser captures leave the key out, so their state must remain unknown.
pub(crate) fn complete_assignment_rubric_fields(
    assignment: &Value,
) -> Result<Map<String, Value>, ProjectionError> {
    assignment_rubric_fields_with_absence(assignment, true)
}

fn assignment_rubric_fields_with_absence(
    assignment: &Value,
    complete_response: bool,
) -> Result<Map<String, Value>, ProjectionError> {
    let object = assignment
        .as_object()
        .ok_or(ProjectionError::InvalidResource)?;
    let mut fields = Map::new();
    if let Some(source) = object.get("rubric") {
        let rubric = match source {
            Value::Null => Value::Null,
            Value::Array(criteria) => Value::Array(
                criteria
                    .iter()
                    .map(project_criterion)
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            _ => return Err(ProjectionError::InvalidResource),
        };
        fields.insert("rubric".into(), rubric);
    } else if complete_response {
        fields.insert("rubric".into(), Value::Null);
    }

    if let Some(source) = object.get("rubric_settings") {
        let settings = match source {
            Value::Null => Value::Null,
            Value::Object(settings) => {
                let mut projected = Map::new();
                for (key, expected) in [
                    ("title", "string"),
                    ("points_possible", "number"),
                    ("free_form_criterion_comments", "boolean"),
                ] {
                    if let Some(value) = settings.get(key) {
                        let valid = value.is_null()
                            || match expected {
                                "string" => value.is_string(),
                                "number" => value.is_number(),
                                "boolean" => value.is_boolean(),
                                _ => false,
                            };
                        if !valid {
                            return Err(ProjectionError::InvalidResource);
                        }
                        projected.insert(key.into(), sanitize_value(value, key)?);
                    }
                }
                Value::Object(projected)
            }
            _ => return Err(ProjectionError::InvalidResource),
        };
        fields.insert("rubric_settings".into(), settings);
    }

    if let Some(source) = object.get("use_rubric_for_grading") {
        let use_rubric = match source {
            Value::Null => Value::Null,
            Value::Bool(value) => Value::Bool(*value),
            _ => return Err(ProjectionError::InvalidResource),
        };
        fields.insert("use_rubric_for_grading".into(), use_rubric);
    }
    Ok(fields)
}

fn project_criterion(value: &Value) -> Result<Value, ProjectionError> {
    let object = value.as_object().ok_or(ProjectionError::InvalidResource)?;
    let mut criterion = Map::new();
    for key in ["id", "description", "long_description", "points"] {
        let projected = match object.get(key) {
            None | Some(Value::Null) => Value::Null,
            Some(value) if key == "points" && value.is_number() => value.clone(),
            Some(value) if key == "id" && (value.is_number() || value.is_string()) => {
                sanitize_value(value, key)?
            }
            Some(Value::String(_)) if key == "description" || key == "long_description" => {
                sanitize_value(&object[key], key)?
            }
            Some(_) => return Err(ProjectionError::InvalidResource),
        };
        criterion.insert(key.into(), projected);
    }
    let ratings = match object.get("ratings") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(ratings)) => ratings
            .iter()
            .map(project_rating)
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err(ProjectionError::InvalidResource),
    };
    criterion.insert("ratings".into(), Value::Array(ratings));
    Ok(Value::Object(criterion))
}

fn project_rating(value: &Value) -> Result<Value, ProjectionError> {
    let object = value.as_object().ok_or(ProjectionError::InvalidResource)?;
    let mut rating = Map::new();
    for key in ["description", "long_description", "points"] {
        let projected = match object.get(key) {
            None | Some(Value::Null) => Value::Null,
            Some(value) if key == "points" && value.is_number() => value.clone(),
            Some(Value::String(_)) if key != "points" => sanitize_value(&object[key], key)?,
            Some(_) => return Err(ProjectionError::InvalidResource),
        };
        rating.insert(key.into(), projected);
    }
    Ok(Value::Object(rating))
}
