use super::*;
use crate::testutil::TempRoot;
use serde_json::json;

fn make_config(root: &Path, course_folder: &Path) {
    fs::write(
        root.join(CONFIG_FILE),
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "courses": {"900001": course_folder}
        }))
        .unwrap(),
    )
    .unwrap();
}

fn coursework() -> Value {
    json!({
        "courses": [{"key":"course-a","canvasCourseId":900001,"code":"SYN-101","title":"Synthetic Course"}],
        "items": [{
            "course":"course-a","kind":"discussion","source":"canvas","canvasResourceType":"discussion","title":"Graded Topic: Lists",
            "canvasId":910001,"assignmentId":910010,"discussionTopicId":910011,
            "dueAtUtc":"2030-01-10T23:59:00Z","detail":"Prompt paragraph.\n\n1. First requirement\n• Second requirement",
            "bodyHtml":"<h2>Prompt</h2><p>Prompt paragraph.</p>",
            "createdAt":"2030-01-08T12:00:00Z","updatedAt":"2030-01-09T12:00:00Z",
            "postedAt":"2030-01-10T00:30:00Z","delayedPostAt":null,
            "unlockAt":"2030-01-10T00:00:00Z","lockAt":null,"dueAt":"2030-01-10T23:59:00Z",
            "points":10,"submissionTypes":["discussion_topic"],"requireInitialPost":true,
            "attachments":[{"id":22,"name":"prompt.pdf"}],
            "linkedFiles":[{"fileId":23,"title":"rubric.pdf"}],
            "rubric":{"criteria":[{"description":"Initial post","points":5,"ratings":[{"description":"Clear argument","points":5}]}]}
        }]
    })
}

#[test]
#[cfg(unix)]
fn writes_marked_readme_and_leaves_identical_file_untouched() {
    let root = TempRoot::new("canvas-item-export");
    let folder = root.path().join("class");
    fs::create_dir(&folder).unwrap();
    make_config(root.path(), &folder);

    let first = export_coursework(root.path(), &coursework());
    assert_eq!(first.status, ExportStatus::Complete);
    assert_eq!(first.written, 1);
    let output = folder.join("assignments/graded-topic-lists/source/README.md");
    let before = fs::metadata(&output).unwrap();
    let before_inode = std::os::unix::fs::MetadataExt::ino(&before);
    assert_eq!(std::os::unix::fs::MetadataExt::mode(&before) & 0o777, 0o600);
    let source_directory = fs::metadata(output.parent().unwrap()).unwrap();
    assert_eq!(
        std::os::unix::fs::MetadataExt::mode(&source_directory) & 0o777,
        0o700
    );
    let text = fs::read_to_string(&output).unwrap();
    assert!(text.starts_with(&format!("{MARKER}\n# Graded Topic: Lists\n")));
    assert!(text.contains("- Course: SYN-101 — Synthetic Course"));
    assert!(text.contains("- Canvas course ID: 900001"));
    assert!(text.contains("- Canvas item ID: 910001"));
    assert!(text.contains("- Canvas assignment ID: 910010"));
    assert!(text.contains("- Canvas discussion topic ID: 910011"));
    assert!(text.contains("- Due: 2030-01-10 06:59 PM ET / 2030-01-10 23:59:00 UTC"));
    assert!(text.contains("- Submission types: discussion_topic"));
    assert!(text.contains("- Require initial post: true"));
    assert!(text.contains("prompt.pdf (ID 22)"));
    assert!(text.contains("rubric.pdf (ID 23)"));
    assert!(text.contains("- **Initial post** (5)"));
    assert!(text.contains("Clear argument (5)"));
    assert!(text.contains("1. First requirement\n• Second requirement"));

    let second = export_coursework(root.path(), &coursework());
    assert_eq!(second.unchanged, 1);
    let after_inode = std::os::unix::fs::MetadataExt::ino(&fs::metadata(&output).unwrap());
    assert_eq!(before_inode, after_inode);
}

#[cfg(unix)]
#[test]
fn restores_owner_file_installed_after_marker_recheck() {
    let root = TempRoot::new("canvas-item-owner-swap-race");
    let folder = root.path().join("class");
    fs::create_dir(&folder).unwrap();
    make_config(root.path(), &folder);
    assert_eq!(export_coursework(root.path(), &coursework()).written, 1);

    let output = folder.join("assignments/graded-topic-lists/source/README.md");
    let owner_content = "Owner-authored concurrent replacement\n";
    let temporary_owner = output.with_extension("owner-swap");
    let outcome = super::io::write_item_file_with_hook(
        &CourseFolder {
            path: folder.clone(),
            canonical: folder,
        },
        Path::new("assignments/graded-topic-lists/source"),
        &format!("{MARKER}\n# Updated generated content\n"),
        || {
            fs::write(&temporary_owner, owner_content).unwrap();
            fs::rename(&temporary_owner, &output).unwrap();
        },
    );

    assert!(matches!(outcome, super::io::ItemWrite::OwnerFile));
    assert_eq!(fs::read_to_string(&output).unwrap(), owner_content);
    let entries = fs::read_dir(output.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(entries, vec![std::ffi::OsString::from("README.md")]);
}

#[test]
fn skips_unmarked_owner_file_without_replacing_it() {
    let root = TempRoot::new("canvas-item-owner-file");
    let folder = root.path().join("class");
    let directory = folder.join("assignments/graded-topic-lists/source");
    fs::create_dir_all(&directory).unwrap();
    make_config(root.path(), &folder);
    fs::write(directory.join("README.md"), "Owner-authored text\n").unwrap();

    let summary = export_coursework(root.path(), &coursework());
    assert_eq!(summary.skipped_owner_files, 1);
    assert_eq!(
        fs::read_to_string(directory.join("README.md")).unwrap(),
        "Owner-authored text\n"
    );
}

#[test]
fn counts_large_unmarked_owner_files_without_reading_their_bodies() {
    use std::io::Read as _;

    let root = TempRoot::new("canvas-item-large-owner-file");
    let folder = root.path().join("class");
    let directory = folder.join("assignments/graded-topic-lists/source");
    fs::create_dir_all(&directory).unwrap();
    make_config(root.path(), &folder);
    let destination = directory.join("README.md");
    fs::write(&destination, "Owner-authored text\n").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&destination)
        .unwrap()
        .set_len(MAX_EXPORT_BYTES as u64 + 1024)
        .unwrap();

    let summary = export_coursework(root.path(), &coursework());
    assert_eq!(summary.status, ExportStatus::Complete);
    assert_eq!(summary.skipped_owner_files, 1);
    let mut prefix = Vec::new();
    std::fs::File::open(&destination)
        .unwrap()
        .take(20)
        .read_to_end(&mut prefix)
        .unwrap();
    assert_eq!(prefix, b"Owner-authored text\n");
}

#[test]
fn missing_or_invalid_configuration_disables_export() {
    let root = TempRoot::new("canvas-item-missing-config");
    assert_eq!(
        export_coursework(root.path(), &coursework()).status,
        ExportStatus::Disabled
    );

    let folder = root.path().join("class");
    fs::create_dir(&folder).unwrap();
    fs::write(
        root.path().join(CONFIG_FILE),
        serde_json::to_vec(&json!({"schemaVersion":1,"courses":{"900001":"/class/../escape"}}))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        export_coursework(root.path(), &coursework()).status,
        ExportStatus::Disabled
    );
}

#[test]
fn exports_canvas_labs_but_ignores_items_without_canvas_provenance() {
    let root = TempRoot::new("canvas-item-provenance");
    let folder = root.path().join("class");
    fs::create_dir(&folder).unwrap();
    make_config(root.path(), &folder);
    let data = json!({
        "courses": [{"key":"course-a","canvasCourseId":900001,"title":"Synthetic Course"}],
        "items": [
            {"course":"course-a","kind":"lab","source":"canvas","canvasId":910002,"canvasResourceType":"assignment","title":"Synthetic Lab","detail":"Lab prompt."},
            {"course":"course-a","kind":"assignment","source":"calendar","canvasId":910003,"canvasResourceType":"assignment","title":"Calendar only","detail":"No Canvas provenance."}
        ]
    });
    let summary = export_coursework(root.path(), &data);
    assert_eq!(summary.written, 1);
    assert!(folder
        .join("assignments/synthetic-lab/source/README.md")
        .is_file());
    assert!(!folder
        .join("assignments/calendar-only/source/README.md")
        .exists());
}

#[test]
fn escapes_markup_from_the_plain_text_body() {
    let root = TempRoot::new("canvas-item-markdown-safety");
    let folder = root.path().join("class");
    fs::create_dir(&folder).unwrap();
    make_config(root.path(), &folder);
    let mut data = coursework();
    data["items"][0]["detail"] = json!("<script>alert(1)</script>\n\n[link](javascript:alert(1))");
    export_coursework(root.path(), &data);
    let text =
        fs::read_to_string(folder.join("assignments/graded-topic-lists/source/README.md")).unwrap();
    assert!(!text.contains("<script>"));
    assert!(text.contains("&lt;script&gt;"));
    assert!(text.contains("\\[link\\](javascript:alert(1))"));
}

#[cfg(unix)]
#[test]
fn refuses_a_symlink_that_escapes_the_configured_folder() {
    use std::os::unix::fs::symlink;

    let root = TempRoot::new("canvas-item-symlink");
    let folder = root.path().join("class");
    let outside = root.path().join("outside");
    fs::create_dir(&folder).unwrap();
    fs::create_dir(&outside).unwrap();
    symlink(&outside, folder.join("assignments")).unwrap();
    make_config(root.path(), &folder);

    let summary = export_coursework(root.path(), &coursework());
    assert_eq!(summary.status, ExportStatus::Failed);
    assert!(!outside.join("graded-topic-lists/source/README.md").exists());
}

#[cfg(unix)]
#[test]
fn rejects_a_symlink_as_the_configured_class_folder() {
    use std::os::unix::fs::symlink;

    let root = TempRoot::new("canvas-item-root-symlink");
    let outside = root.path().join("outside");
    let configured = root.path().join("class-link");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, &configured).unwrap();
    make_config(root.path(), &configured);

    let summary = export_coursework(root.path(), &coursework());
    assert_eq!(summary.status, ExportStatus::Disabled);
    assert!(!outside.join("assignments").exists());
}

#[cfg(unix)]
#[test]
fn rejects_a_symlink_intermediate_in_the_configured_folder() {
    use std::os::unix::fs::symlink;

    let root = TempRoot::new("canvas-item-intermediate-symlink");
    let outside = root.path().join("outside");
    let linked_parent = root.path().join("class-link");
    fs::create_dir_all(outside.join("child")).unwrap();
    symlink(&outside, &linked_parent).unwrap();
    let configured = linked_parent.join("child");
    make_config(root.path(), &configured);

    let summary = export_coursework(root.path(), &coursework());
    assert_eq!(summary.status, ExportStatus::Disabled);
    assert!(!outside.join("child/assignments").exists());
}
