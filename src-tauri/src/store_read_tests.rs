use super::read_capped_under;
#[cfg(unix)]
use super::{
    read_capped_under_with_hook, remove_files_under_with_hook, StoreReadHookPoint as HookPoint,
};
#[cfg(unix)]
use crate::store::remove_files_under;
use crate::store::StoreError;
use crate::testutil::TempRoot;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::sync::mpsc;
#[cfg(unix)]
use std::thread;
#[cfg(unix)]
use std::time::{Duration, Instant};

fn write(root: &Path, relative: &str, bytes: &[u8]) -> PathBuf {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
    path
}

#[test]
#[cfg(unix)]
fn reads_nested_regular_files_from_the_anchored_handle_and_enforces_the_cap() {
    let root = TempRoot::new("store-read-bounded");
    write(root.path(), "classes/course/api/course.json", b"synthetic");

    assert_eq!(
        read_capped_under(root.path(), Path::new("classes/course/api/course.json"), 9).unwrap(),
        Some(b"synthetic".to_vec())
    );
    assert!(matches!(
        read_capped_under(root.path(), Path::new("classes/course/api/course.json"), 8),
        Err(StoreError::TooLarge)
    ));
    assert_eq!(
        read_capped_under(root.path(), Path::new("missing.json"), 20).unwrap(),
        None
    );
}

#[cfg(unix)]
#[test]
fn rejects_static_leaf_and_ancestor_symlinks_without_reading_targets() {
    use std::os::unix::fs::symlink;

    let root = TempRoot::new("store-read-symlink");
    write(root.path(), "outside.json", b"outside sentinel");
    symlink(
        root.path().join("outside.json"),
        root.path().join("leaf.json"),
    )
    .unwrap();
    fs::create_dir(root.path().join("real-classes")).unwrap();
    symlink(
        root.path().join("real-classes"),
        root.path().join("classes"),
    )
    .unwrap();

    assert!(matches!(
        read_capped_under(root.path(), Path::new("leaf.json"), 100),
        Err(StoreError::Invalid(_))
    ));
    assert!(matches!(
        read_capped_under(root.path(), Path::new("classes/course.json"), 100),
        Err(StoreError::Invalid(_))
    ));
    assert_eq!(
        fs::read(root.path().join("outside.json")).unwrap(),
        b"outside sentinel"
    );
}

#[cfg(unix)]
#[test]
fn rejects_a_leaf_swapped_to_an_outside_hard_link_and_restored_before_identity_check() {
    let root = TempRoot::new("store-read-leaf-race");
    let original = write(root.path(), "inside/document.json", b"inside");
    let outside = write(root.path(), "outside.json", b"outside sentinel");
    let outside_for_hook = outside.clone();
    let saved = root.path().join("inside/document.saved");
    let replacement = original.clone();
    let mut read_reached = false;

    let result = read_capped_under_with_hook(
        root.path(),
        Path::new("inside/document.json"),
        100,
        |point| match point {
            HookPoint::BeforeLeafOpen => {
                fs::rename(&replacement, &saved).unwrap();
                fs::hard_link(&outside_for_hook, &replacement).unwrap();
            }
            HookPoint::AfterLeafOpen => {
                fs::remove_file(&replacement).unwrap();
                fs::rename(&saved, &replacement).unwrap();
            }
            HookPoint::BeforeRead => read_reached = true,
            _ => {}
        },
    );

    assert!(matches!(result, Err(StoreError::Invalid(_))));
    assert!(
        !read_reached,
        "the substituted handle was rejected before reading"
    );
    assert_eq!(fs::read(original).unwrap(), b"inside");
    assert_eq!(fs::read(outside).unwrap(), b"outside sentinel");
}

#[cfg(unix)]
#[test]
fn rejects_an_ancestor_swapped_to_an_outside_directory_and_restored_after_open() {
    let root = TempRoot::new("store-read-ancestor-race");
    write(root.path(), "classes/course/document.json", b"inside");
    write(
        root.path(),
        "outside/course/document.json",
        b"outside sentinel",
    );
    let classes = root.path().join("classes");
    let held = root.path().join("classes.saved");
    let outside = root.path().join("outside");
    let mut swapped = false;
    let mut read_reached = false;

    let result = read_capped_under_with_hook(
        root.path(),
        Path::new("classes/course/document.json"),
        100,
        |point| match point {
            HookPoint::BeforeDirectoryOpen(0) => {
                fs::rename(&classes, &held).unwrap();
                fs::rename(&outside, &classes).unwrap();
                swapped = true;
            }
            HookPoint::AfterDirectoryOpen(0) if swapped => {
                fs::rename(&classes, &outside).unwrap();
                fs::rename(&held, &classes).unwrap();
                swapped = false;
            }
            HookPoint::BeforeRead => read_reached = true,
            _ => {}
        },
    );

    assert!(matches!(result, Err(StoreError::Invalid(_))));
    assert!(
        !read_reached,
        "the substituted ancestor was rejected before reading"
    );
    assert_eq!(
        fs::read(classes.join("course/document.json")).unwrap(),
        b"inside"
    );
    assert_eq!(
        fs::read(outside.join("course/document.json")).unwrap(),
        b"outside sentinel"
    );
}

#[cfg(unix)]
#[test]
fn a_fifo_replacement_is_opened_nonblocking_then_rejected_by_fstat() {
    use std::ffi::CString;
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;

    let root = TempRoot::new("store-read-fifo-race");
    let path = write(root.path(), "document.json", b"synthetic");
    let replacement = path.clone();
    let root_path = root.path().to_path_buf();
    let (replaced_tx, replaced_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        let result = read_capped_under_with_hook(
            &root_path,
            Path::new("document.json"),
            100,
            move |point| {
                if point == HookPoint::BeforeLeafOpen {
                    fs::remove_file(&replacement).unwrap();
                    let name = CString::new(replacement.as_os_str().as_bytes()).unwrap();
                    // SAFETY: name is a live NUL-terminated path and mode is a valid permission mask.
                    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
                    replaced_tx.send(()).unwrap();
                }
            },
        );
        result_tx.send(result).unwrap();
    });

    replaced_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("the synthetic FIFO replacement was installed");
    let first_result = result_rx.recv_timeout(Duration::from_secs(1));
    let returned_without_unblocking = first_result.is_ok();
    if !returned_without_unblocking {
        let name = CString::new(path.as_os_str().as_bytes()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut fd = -1;
        while Instant::now() < deadline {
            // SAFETY: name is the synthetic FIFO and O_NONBLOCK makes this probe bounded.
            fd = unsafe {
                libc::open(
                    name.as_ptr(),
                    libc::O_WRONLY | libc::O_NONBLOCK | libc::O_CLOEXEC,
                )
            };
            if fd >= 0 {
                break;
            }
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ENXIO),
                "the synthetic FIFO remains available while waiting for the reader"
            );
            thread::sleep(Duration::from_millis(10));
        }
        if fd < 0 {
            // SAFETY: O_RDWR|O_NONBLOCK is a final bounded release on platforms where the
            // writer-only probe does not pair with the blocked reader as expected.
            fd = unsafe {
                libc::open(
                    name.as_ptr(),
                    libc::O_RDWR | libc::O_NONBLOCK | libc::O_CLOEXEC,
                )
            };
        }
        assert!(
            fd >= 0,
            "the test can release a regressed blocking FIFO open"
        );
        // SAFETY: open returned a new owned descriptor.
        let unblocker = unsafe { fs::File::from_raw_fd(fd) };
        let _ = result_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the bounded unblock released the reader thread");
        drop(unblocker);
    }
    worker.join().unwrap();
    assert!(
        returned_without_unblocking,
        "FIFO replacement blocked despite the test's bounded release"
    );
    assert!(matches!(first_result.unwrap(), Err(StoreError::Invalid(_))));
    fs::remove_file(path).unwrap();
}

#[cfg(unix)]
#[test]
fn deletion_validates_the_whole_inventory_before_unlinking_any_file() {
    let root = TempRoot::new("store-remove-inventory");
    write(root.path(), "classes/course/materials/first.pdf", b"first");
    let paths = [
        PathBuf::from("classes/course/materials/first.pdf"),
        PathBuf::from("classes/course/materials/missing.pdf"),
    ];

    assert!(remove_files_under(root.path(), &paths).is_err());
    assert_eq!(
        fs::read(root.path().join("classes/course/materials/first.pdf")).unwrap(),
        b"first"
    );
}

#[cfg(unix)]
#[test]
fn deletion_rechecks_anchored_parent_before_unlink_and_leaves_outside_target_intact() {
    let root = TempRoot::new("store-remove-ancestor-race");
    write(
        root.path(),
        "classes/course/materials/legacy.pdf",
        b"legacy",
    );
    write(
        root.path(),
        "outside/course/materials/legacy.pdf",
        b"outside sentinel",
    );
    let classes = root.path().join("classes");
    let held = root.path().join("classes.saved");
    let outside = root.path().join("outside");
    let paths = [PathBuf::from("classes/course/materials/legacy.pdf")];
    let mut swapped = false;

    let result = remove_files_under_with_hook(root.path(), &paths, |point| {
        if point == HookPoint::BeforeUnlink(0) {
            fs::rename(&classes, &held).unwrap();
            fs::rename(&outside, &classes).unwrap();
            swapped = true;
        }
    });
    if swapped {
        fs::rename(&classes, &outside).unwrap();
        fs::rename(&held, &classes).unwrap();
    }

    assert!(matches!(result, Err(StoreError::Invalid(_))));
    assert_eq!(
        fs::read(classes.join("course/materials/legacy.pdf")).unwrap(),
        b"legacy"
    );
    assert_eq!(
        fs::read(outside.join("course/materials/legacy.pdf")).unwrap(),
        b"outside sentinel"
    );
}
