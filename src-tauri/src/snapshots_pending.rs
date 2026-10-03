use super::{valid_pending_name, StoreError};
use std::ffi::{CStr, CString};
use std::fs::{self, File};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Identity {
    device: u64,
    inode: u64,
    kind: u32,
    owner: u32,
    mode: u32,
}

impl Identity {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            kind: metadata.mode() & libc::S_IFMT as u32,
            owner: metadata.uid(),
            mode: metadata.mode() & 0o7777,
        }
    }

    fn from_stat(stat: &libc::stat) -> Self {
        Self {
            device: stat.st_dev as u64,
            inode: stat.st_ino as u64,
            kind: (stat.st_mode as u32) & libc::S_IFMT as u32,
            owner: stat.st_uid as u32,
            mode: (stat.st_mode as u32) & 0o7777,
        }
    }

    fn is_private_directory(self) -> bool {
        self.kind == libc::S_IFDIR as u32
            && self.owner == unsafe { libc::geteuid() } as u32
            && self.mode == 0o700
    }
}

struct DirectoryStream(*mut libc::DIR);

impl Drop for DirectoryStream {
    fn drop(&mut self) {
        // SAFETY: this pointer was returned by fdopendir and is closed exactly once here.
        unsafe { libc::closedir(self.0) };
    }
}

fn invalid() -> StoreError {
    StoreError::Invalid("snapshot path changed during pending cleanup")
}

fn open_root(path: &Path) -> Result<File, StoreError> {
    let before = fs::symlink_metadata(path)?;
    let before_identity = Identity::from_metadata(&before);
    if !before_identity.is_private_directory() {
        return Err(StoreError::Invalid("snapshots folder is not private"));
    }
    let path_c = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| StoreError::Invalid("invalid snapshots folder"))?;
    // SAFETY: path_c is a live NUL-terminated absolute path. O_NOFOLLOW rejects a replaced
    // snapshots symlink, and the resulting descriptor anchors all subsequent deletions.
    let fd = unsafe {
        libc::open(
            path_c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error().into());
    }
    // SAFETY: open returned a new owned descriptor.
    let root = unsafe { File::from_raw_fd(fd) };
    let opened = Identity::from_metadata(&root.metadata()?);
    let after = fs::symlink_metadata(path)?;
    if opened != before_identity || Identity::from_metadata(&after) != before_identity {
        return Err(invalid());
    }
    Ok(root)
}

fn stat_at(parent: &File, name: &CString) -> io::Result<libc::stat> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: stat points to writable storage; name is NUL-terminated; parent is open.
    let result = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fstatat succeeded and initialized stat.
    Ok(unsafe { stat.assume_init() })
}

#[cfg(target_os = "macos")]
unsafe fn errno_location() -> *mut libc::c_int {
    // SAFETY: libc returns the current thread's errno slot.
    unsafe { libc::__error() }
}

#[cfg(target_os = "linux")]
unsafe fn errno_location() -> *mut libc::c_int {
    // SAFETY: libc returns the current thread's errno slot.
    unsafe { libc::__errno_location() }
}

fn names_at(directory: &File) -> Result<Vec<CString>, StoreError> {
    // SAFETY: dup creates a descriptor owned by fdopendir while the original stays open.
    let duplicate = unsafe { libc::dup(directory.as_raw_fd()) };
    if duplicate < 0 {
        return Err(io::Error::last_os_error().into());
    }
    // SAFETY: duplicate is a valid descriptor, transferred to the returned DIR stream.
    let stream = unsafe { libc::fdopendir(duplicate) };
    if stream.is_null() {
        // SAFETY: fdopendir failed and did not take ownership of duplicate.
        unsafe { libc::close(duplicate) };
        return Err(io::Error::last_os_error().into());
    }
    let stream = DirectoryStream(stream);
    let mut names = Vec::new();
    loop {
        // SAFETY: errno_location points to this thread's errno slot.
        unsafe { *errno_location() = 0 };
        // SAFETY: stream remains open and readdir returns storage owned by that stream.
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            // SAFETY: errno_location points to this thread's errno slot.
            let error = unsafe { *errno_location() };
            if error != 0 {
                return Err(io::Error::from_raw_os_error(error).into());
            }
            break;
        }
        // SAFETY: d_name is NUL-terminated by readdir and copied before the next call.
        let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        names.push(CString::new(bytes).map_err(|_| StoreError::Invalid("invalid snapshot entry"))?);
    }
    Ok(names)
}

fn open_child_directory(parent: &File, name: &CString) -> Result<Option<File>, StoreError> {
    // SAFETY: name is NUL-terminated and parent is an open directory descriptor.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::NotFound {
            return Ok(None);
        }
        if error.kind() == io::ErrorKind::NotADirectory {
            return Ok(None);
        }
        return Err(error.into());
    }
    // SAFETY: openat returned a new owned descriptor.
    Ok(Some(unsafe { File::from_raw_fd(fd) }))
}

fn unlink_at(parent: &File, name: &CString, flags: libc::c_int) -> io::Result<()> {
    // SAFETY: parent is an open directory descriptor and name is NUL-terminated.
    let result = unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn remove_contents(directory: &File, root_device: u64) -> Result<(), StoreError> {
    for name in names_at(directory)? {
        let before = match stat_at(directory, &name) {
            Ok(stat) => Identity::from_stat(&stat),
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if before.device != root_device {
            return Err(invalid());
        }
        if before.kind == libc::S_IFDIR as u32 {
            let Some(child) = open_child_directory(directory, &name)? else {
                continue;
            };
            let opened = Identity::from_metadata(&child.metadata()?);
            if opened.device != before.device
                || opened.inode != before.inode
                || opened.kind != before.kind
            {
                return Err(invalid());
            }
            remove_contents(&child, root_device)?;
            let current = Identity::from_stat(&stat_at(directory, &name)?);
            if current.device != opened.device
                || current.inode != opened.inode
                || current.kind != opened.kind
            {
                return Err(invalid());
            }
            unlink_at(directory, &name, libc::AT_REMOVEDIR)?;
        } else {
            let current = Identity::from_stat(&stat_at(directory, &name)?);
            if current != before {
                return Err(invalid());
            }
            // unlinkat removes a symlink itself; it never follows its target.
            unlink_at(directory, &name, 0)?;
        }
    }
    Ok(())
}

fn remove_candidate(root: &File, name: CString) -> Result<bool, StoreError> {
    let text = name.to_string_lossy();
    if !valid_pending_name(&text) {
        return Ok(false);
    }
    let before = match stat_at(root, &name) {
        Ok(stat) => Identity::from_stat(&stat),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if !before.is_private_directory() {
        return Ok(false);
    }
    let Some(pending) = open_child_directory(root, &name)? else {
        return Ok(false);
    };
    let opened = Identity::from_metadata(&pending.metadata()?);
    if opened != before {
        return Ok(false);
    }
    remove_contents(&pending, opened.device)?;
    let current = Identity::from_stat(&stat_at(root, &name)?);
    if current != opened {
        return Err(invalid());
    }
    unlink_at(root, &name, libc::AT_REMOVEDIR)?;
    Ok(true)
}

pub(super) fn cleanup(directory: &Path) -> Result<(), StoreError> {
    let root = open_root(directory)?;
    let mut removed_any = false;
    for name in names_at(&root)? {
        removed_any |= remove_candidate(&root, name)?;
    }
    if removed_any {
        root.sync_all()?;
    }
    Ok(())
}
