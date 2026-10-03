use super::*;
use crate::store::{new_preview_manifest, node_json_bytes};
use crate::testutil::{assert_private_tree, TempRoot};
use std::sync::mpsc;
use std::time::{Duration, UNIX_EPOCH};

fn ready_store(temp: &TempRoot) -> Store {
    let store = Store::open(temp.path(), Duration::from_millis(200)).unwrap();
    create_private_dir(&store.store_dir(), false).unwrap();
    atomic_write(
        &store.store_dir().join(MANIFEST_FILE),
        &node_json_bytes(&new_preview_manifest(1, 1, "synthetic", UNIX_EPOCH)),
    )
    .unwrap();
    atomic_write(&store.store_dir().join("coursework.json"), b"coursework").unwrap();
    store
}

fn add_committed_snapshot(directory: &Path, id: &str, bytes: &[u8]) {
    let path = directory.join(id);
    create_private_dir(&path, false).unwrap();
    atomic_write(&path.join("committed.data"), bytes).unwrap();
}

#[test]
fn daily_dedup_rotation_and_restore_archive() {
    let temp = TempRoot::new("snapshots");
    let store = ready_store(&temp);
    let first = snapshot_daily(&store, UNIX_EPOCH).unwrap().unwrap();
    assert!(snapshot_daily(&store, UNIX_EPOCH).unwrap().is_none());
    for n in 1..=MAX_SNAPSHOTS {
        take(
            &store,
            "refresh",
            UNIX_EPOCH + Duration::from_secs(n as u64),
            &mut |_| {},
        )
        .unwrap();
    }
    assert_eq!(
        snapshot_before_refresh(&store, "synthetic refresh")
            .unwrap()
            .kind,
        "pre-refresh"
    );
    assert_eq!(list_snapshots(&store).unwrap().len(), MAX_SNAPSHOTS);
    assert!(!root(&store).join(first.id).exists());
    let latest = list_snapshots(&store).unwrap()[0].id.clone();
    atomic_write(&store.store_dir().join("coursework.json"), b"second").unwrap();
    restore_snapshot(&store, &latest).unwrap();
    assert_eq!(
        fs::read(store.store_dir().join("coursework.json")).unwrap(),
        b"coursework"
    );
    assert_eq!(fs::read_dir(store.backups_dir()).unwrap().count(), 1);
    assert_private_tree(&store.backups_dir());
    assert_private_tree(&root(&store));
}

#[test]
fn pending_copy_is_invisible_until_atomic_publication_completes() {
    let temp = TempRoot::new("snapshot-publish");
    let store = ready_store(&temp);
    let directory = root(&store);
    create_private_dir(&directory, false).unwrap();
    let id = "refresh-20261002T120000Z-0123abcd".to_owned();
    let (copied_tx, copied_rx) = mpsc::channel();
    let (publish_tx, publish_rx) = mpsc::channel();
    let worker_directory = directory.clone();
    let worker_id = id.clone();
    let worker = std::thread::spawn(move || {
        publish_snapshot(&worker_directory, &worker_id, |pending| {
            atomic_write(&pending.join("coursework.json"), b"partial")?;
            copied_tx
                .send(())
                .map_err(|_| StoreError::Invalid("test synchronization failed"))?;
            publish_rx
                .recv_timeout(Duration::from_secs(5))
                .map_err(|_| StoreError::Invalid("test synchronization timed out"))?;
            atomic_write(&pending.join("coursework.json"), b"complete")?;
            Ok(())
        })
    });

    copied_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let pending = fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .find(|name| name.starts_with(".pending-"))
        .expect("copy should be in a hidden pending directory");
    assert!(snapshots(&store).unwrap().is_empty());
    assert_eq!(
        fs::read(directory.join(&pending).join("coursework.json")).unwrap(),
        b"partial"
    );
    assert!(restore_snapshot(&store, &pending).is_err());

    publish_tx.send(()).unwrap();
    worker.join().unwrap().unwrap();
    let listed = list_snapshots(&store).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, id);
    assert_eq!(
        fs::read(directory.join(id).join("coursework.json")).unwrap(),
        b"complete"
    );
    assert_private_tree(&directory);
}

#[test]
fn failed_copy_after_file_copy_preserves_maximum_committed_snapshots() {
    let temp = TempRoot::new("snapshot-failed-copy");
    let store = ready_store(&temp);
    let directory = root(&store);
    create_private_dir(&directory, false).unwrap();
    for index in 0..MAX_SNAPSHOTS {
        let id = format!("refresh-20260101T0000{index:02}Z-{index:08x}");
        add_committed_snapshot(&directory, &id, &[index as u8, 0x5a, 0xa5]);
    }
    let before = list_snapshots(&store).unwrap();
    let contents = before
        .iter()
        .map(|snapshot| {
            (
                snapshot.id.clone(),
                fs::read(directory.join(&snapshot.id).join("committed.data")).unwrap(),
            )
        })
        .collect::<Vec<_>>();

    let error = {
        let _snapshot_lock = store.snapshot_lock().unwrap();
        take_locked_with_copy(
            &store,
            "refresh",
            UNIX_EPOCH + Duration::from_secs(100),
            &mut |_| {},
            |source, pending, progress| {
                crate::export::copy_tree_into_private_root(source, pending, true, progress)?;
                Err(StoreError::Invalid("injected post-copy failure"))
            },
        )
        .unwrap_err()
    };
    assert!(matches!(
        error,
        StoreError::Invalid("injected post-copy failure")
    ));

    let after = list_snapshots(&store).unwrap();
    assert_eq!(after.len(), MAX_SNAPSHOTS);
    assert_eq!(
        after
            .iter()
            .map(|snapshot| snapshot.id.clone())
            .collect::<Vec<_>>(),
        before
            .iter()
            .map(|snapshot| snapshot.id.clone())
            .collect::<Vec<_>>()
    );
    for (id, bytes) in contents {
        assert_eq!(
            fs::read(directory.join(id).join("committed.data")).unwrap(),
            bytes
        );
    }
    assert_eq!(
        fs::read_dir(&directory)
            .unwrap()
            .filter(|entry| entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".pending-"))
            .count(),
        0,
        "the failed writer should remove only its own pending directory"
    );
}

#[test]
fn interrupted_same_day_pending_is_not_listed_restored_deduplicated_or_rotated() {
    let temp = TempRoot::new("snapshot-interrupted");
    let store = ready_store(&temp);
    let directory = root(&store);
    create_private_dir(&directory, false).unwrap();
    for index in 0..MAX_SNAPSHOTS {
        let id = format!("refresh-20260101T0000{index:02}Z-{index:08x}");
        add_committed_snapshot(&directory, &id, &[index as u8]);
    }
    let now = UNIX_EPOCH + Duration::from_secs(2_000_000_000);
    let pending_id = format!(".pending-daily-{}-0123abcd", utc_stamp(now).compact);
    let pending_path = directory.join(&pending_id);
    create_private_dir(&pending_path, false).unwrap();
    atomic_write(&pending_path.join("partial.data"), b"interrupted bytes").unwrap();
    let oldest = list_snapshots(&store).unwrap().last().unwrap().id.clone();

    let before = list_snapshots(&store).unwrap();
    assert_eq!(before.len(), MAX_SNAPSHOTS);
    assert!(before.iter().all(|snapshot| snapshot.id != pending_id));
    assert!(restore_snapshot(&store, &pending_id).is_err());

    let daily = snapshot_daily(&store, now)
        .unwrap()
        .expect("an abandoned pending directory must not satisfy daily deduplication");
    assert_eq!(daily.kind, "daily");
    let after = list_snapshots(&store).unwrap();
    assert_eq!(after.len(), MAX_SNAPSHOTS);
    assert!(after.iter().any(|snapshot| snapshot.id == daily.id));
    assert!(!directory.join(oldest).exists());
    assert_eq!(
        fs::read(pending_path.join("partial.data")).unwrap(),
        b"interrupted bytes",
        "rotation must leave interrupted pending data alone"
    );
    assert_private_tree(&directory);
}

#[cfg(unix)]
#[test]
fn next_snapshot_reclaims_only_private_generated_pending_directories() {
    use std::os::unix::fs::symlink;

    let temp = TempRoot::new("snapshot-pending-cleanup");
    let store = ready_store(&temp);
    let directory = root(&store);
    create_private_dir(&directory, false).unwrap();

    let committed_id = format!("refresh-{}-0123abcd", utc_stamp(UNIX_EPOCH).compact);
    add_committed_snapshot(&directory, &committed_id, b"keep committed snapshot");

    let pending_id = format!(
        "refresh-{}-89abcdef",
        utc_stamp(UNIX_EPOCH + Duration::from_secs(10)).compact
    );
    let pending_name = format!(".pending-{pending_id}-{}", uuid::Uuid::new_v4());
    assert!(valid_pending_name(&pending_name));
    let pending = directory.join(&pending_name);
    create_private_dir(&pending, false).unwrap();
    atomic_write(&pending.join("partial.data"), b"interrupted copy").unwrap();

    let outside = temp.path().join("outside");
    create_private_dir(&outside, false).unwrap();
    let outside_marker = outside.join("keep.data");
    atomic_write(&outside_marker, b"outside data").unwrap();
    symlink(&outside, pending.join("outside-link")).unwrap();

    let pending_link = directory.join(format!(".pending-{pending_id}-{}", uuid::Uuid::new_v4()));
    symlink(&outside, &pending_link).unwrap();

    let arbitrary_pending = directory.join(".pending-arbitrary-prefix");
    create_private_dir(&arbitrary_pending, false).unwrap();
    let compact_uuid_pending = directory.join(format!(
        ".pending-{pending_id}-{}",
        uuid::Uuid::new_v4().simple()
    ));
    create_private_dir(&compact_uuid_pending, false).unwrap();

    let now = UNIX_EPOCH + Duration::from_secs(2_000_000_000);
    snapshot_daily(&store, now).unwrap().unwrap();

    assert!(!pending.exists(), "interrupted owned copy is reclaimed");
    assert_eq!(
        fs::read(directory.join(&committed_id).join("committed.data")).unwrap(),
        b"keep committed snapshot"
    );
    assert!(
        fs::symlink_metadata(&pending_link)
            .unwrap()
            .file_type()
            .is_symlink(),
        "matching symlinks are left alone"
    );
    assert_eq!(fs::read(outside_marker).unwrap(), b"outside data");
    assert!(
        arbitrary_pending.is_dir(),
        "unrecognized names are left alone"
    );
    assert!(
        compact_uuid_pending.is_dir(),
        "non-generated UUIDs are left alone"
    );
    assert!(
        list_snapshots(&store)
            .unwrap()
            .iter()
            .any(|snapshot| snapshot.id == committed_id),
        "cleanup preserves committed snapshots"
    );
}
