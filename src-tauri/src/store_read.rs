//! Descriptor-anchored reads and removals for store-owned files.

use std::fs::File;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use super::StoreError;

#[cfg(unix)]
mod unix {
    use super::*;
    use std::ffi::CString;
    use std::fs;
    use std::mem::MaybeUninit;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    struct Identity {
        device: u64,
        inode: u64,
        kind: u32,
    }

    impl Identity {
        fn from_stat(stat: &libc::stat) -> Self {
            Self {
                device: stat.st_dev as u64,
                inode: stat.st_ino as u64,
                kind: (stat.st_mode as u32) & libc::S_IFMT as u32,
            }
        }

        fn from_metadata(metadata: &fs::Metadata) -> Self {
            Self {
                device: metadata.dev(),
                inode: metadata.ino(),
                kind: metadata.mode() & libc::S_IFMT as u32,
            }
        }

        fn regular(self) -> bool {
            self.kind == libc::S_IFREG as u32
        }

        fn directory(self) -> bool {
            self.kind == libc::S_IFDIR as u32
        }
    }

    struct OpenedDirectory {
        name: CString,
        file: File,
        identity: Identity,
    }

    struct ValidatedRemoval {
        directories: Vec<OpenedDirectory>,
        leaf: CString,
        identity: Identity,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(crate) enum HookPoint {
        BeforeRootOpen,
        AfterRootOpen,
        BeforeDirectoryOpen(usize),
        AfterDirectoryOpen(usize),
        BeforeLeafOpen,
        AfterLeafOpen,
        BeforeRead,
        AfterRemovalInventory,
        BeforeUnlink(usize),
    }

    fn invalid() -> StoreError {
        StoreError::Invalid("a store path changed or is not a regular file")
    }

    fn path_components(path: &Path) -> Result<Vec<CString>, StoreError> {
        let mut components = Vec::new();
        for part in path.components() {
            let Component::Normal(name) = part else {
                return Err(StoreError::InvalidName);
            };
            let name = CString::new(name.as_bytes()).map_err(|_| StoreError::InvalidName)?;
            if name.as_bytes().is_empty() {
                return Err(StoreError::InvalidName);
            }
            components.push(name);
        }
        if components.is_empty() {
            return Err(StoreError::InvalidName);
        }
        Ok(components)
    }

    fn root_metadata(root: &Path) -> Result<Option<fs::Metadata>, StoreError> {
        if !root.is_absolute()
            || root
                .components()
                .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        {
            return Err(StoreError::InvalidName);
        }
        match fs::symlink_metadata(root) {
            Ok(metadata) if metadata.file_type().is_dir() => Ok(Some(metadata)),
            Ok(_) => Err(invalid()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn open_root<F>(root: &Path, hook: &mut F) -> Result<Option<(File, Identity)>, StoreError>
    where
        F: FnMut(HookPoint),
    {
        let Some(before) = root_metadata(root)? else {
            return Ok(None);
        };
        let before_identity = Identity::from_metadata(&before);
        hook(HookPoint::BeforeRootOpen);
        let root_c =
            CString::new(root.as_os_str().as_bytes()).map_err(|_| StoreError::InvalidName)?;
        // SAFETY: root_c is NUL terminated and remains live for the call.
        let fd = unsafe {
            libc::open(
                root_c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        // SAFETY: open returned a new owned file descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        hook(HookPoint::AfterRootOpen);
        let opened = file.metadata()?;
        let opened_identity = Identity::from_metadata(&opened);
        let after = root_metadata(root)?.ok_or_else(invalid)?;
        if !opened_identity.directory()
            || opened_identity != before_identity
            || Identity::from_metadata(&after) != before_identity
        {
            return Err(invalid());
        }
        Ok(Some((file, opened_identity)))
    }

    fn stat_at(parent: &File, name: &CString) -> io::Result<libc::stat> {
        let mut stat = MaybeUninit::<libc::stat>::uninit();
        // SAFETY: stat points to writable storage and name is NUL terminated.
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

    fn open_at(parent: &File, name: &CString, flags: libc::c_int) -> io::Result<File> {
        // SAFETY: name is NUL terminated and parent is a live directory descriptor.
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: openat returned a new owned file descriptor.
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    fn not_found(error: &io::Error) -> bool {
        error.kind() == io::ErrorKind::NotFound
    }

    fn check_directory_chain(
        root: &Path,
        root_file: &File,
        root_identity: Identity,
        directories: &[OpenedDirectory],
    ) -> Result<(), StoreError> {
        let path_identity = root_metadata(root)?.map(|m| Identity::from_metadata(&m));
        let fd_identity = Identity::from_metadata(&root_file.metadata()?);
        if path_identity != Some(root_identity) || fd_identity != root_identity {
            return Err(invalid());
        }
        let mut parent = root_file;
        for directory in directories {
            let current = stat_at(parent, &directory.name).map_err(|_| invalid())?;
            let descriptor = directory.file.metadata()?;
            if Identity::from_stat(&current) != directory.identity
                || Identity::from_metadata(&descriptor) != directory.identity
                || !directory.identity.directory()
            {
                return Err(invalid());
            }
            parent = &directory.file;
        }
        Ok(())
    }

    fn open_directory<F>(
        root: &Path,
        root_file: &File,
        root_identity: Identity,
        directories: &mut Vec<OpenedDirectory>,
        name: &CString,
        index: usize,
        hook: &mut F,
    ) -> Result<(), StoreError>
    where
        F: FnMut(HookPoint),
    {
        check_directory_chain(root, root_file, root_identity, directories)?;
        let parent = directories
            .last()
            .map_or(root_file, |directory| &directory.file);
        let before = match stat_at(parent, name) {
            Ok(stat) => stat,
            Err(error) if not_found(&error) => return Err(StoreError::Io(error)),
            Err(error) => return Err(error.into()),
        };
        let expected = Identity::from_stat(&before);
        if !expected.directory() {
            return Err(invalid());
        }
        hook(HookPoint::BeforeDirectoryOpen(index));
        let file = open_at(
            parent,
            name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(StoreError::Io)?;
        hook(HookPoint::AfterDirectoryOpen(index));
        if Identity::from_metadata(&file.metadata()?) != expected {
            return Err(invalid());
        }
        let after = stat_at(parent, name).map_err(|_| invalid())?;
        if Identity::from_stat(&after) != expected {
            return Err(invalid());
        }
        directories.push(OpenedDirectory {
            name: name.clone(),
            file,
            identity: expected,
        });
        check_directory_chain(root, root_file, root_identity, directories)
    }

    fn read_bounded(file: &mut File, cap: u64) -> Result<Vec<u8>, StoreError> {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            let remaining = cap.saturating_sub(bytes.len() as u64);
            let read_limit = remaining.saturating_add(1).min(buffer.len() as u64) as usize;
            let count = file.read(&mut buffer[..read_limit])?;
            if count == 0 {
                return Ok(bytes);
            }
            if count as u64 > remaining {
                return Err(StoreError::TooLarge);
            }
            bytes.extend_from_slice(&buffer[..count]);
        }
    }

    pub(crate) fn read_capped(path: &Path, cap: u64) -> Result<Option<Vec<u8>>, StoreError> {
        let leaf = path.file_name().ok_or(StoreError::InvalidName)?;
        let parent = path
            .parent()
            .filter(|value| !value.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let root = if parent.is_absolute() {
            parent.to_path_buf()
        } else {
            std::env::current_dir()?.join(parent)
        };
        read_capped_under(&root, Path::new(leaf), cap)
    }

    pub(crate) fn read_capped_under(
        root: &Path,
        relative: &Path,
        cap: u64,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        read_capped_under_with_hook(root, relative, cap, |_| {})
    }

    pub(crate) fn read_capped_under_with_hook<F>(
        root: &Path,
        relative: &Path,
        cap: u64,
        mut hook: F,
    ) -> Result<Option<Vec<u8>>, StoreError>
    where
        F: FnMut(HookPoint),
    {
        let components = path_components(relative)?;
        let Some((root_file, root_identity)) = open_root(root, &mut hook)? else {
            return Ok(None);
        };
        let mut directories = Vec::with_capacity(components.len().saturating_sub(1));
        for (index, name) in components[..components.len() - 1].iter().enumerate() {
            let parent = directories
                .last()
                .map_or(&root_file, |directory: &OpenedDirectory| &directory.file);
            match stat_at(parent, name) {
                Err(error) if not_found(&error) => return Ok(None),
                Err(error) => return Err(error.into()),
                Ok(_) => {}
            }
            open_directory(
                root,
                &root_file,
                root_identity,
                &mut directories,
                name,
                index,
                &mut hook,
            )?;
        }
        let leaf = components.last().ok_or(StoreError::InvalidName)?;
        check_directory_chain(root, &root_file, root_identity, &directories)?;
        let parent = directories
            .last()
            .map_or(&root_file, |directory| &directory.file);
        let before = match stat_at(parent, leaf) {
            Ok(stat) => stat,
            Err(error) if not_found(&error) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let expected = Identity::from_stat(&before);
        if !expected.regular() {
            return Err(invalid());
        }
        if before.st_size < 0 || before.st_size as u64 > cap {
            return Err(StoreError::TooLarge);
        }
        hook(HookPoint::BeforeLeafOpen);
        let mut file = open_at(
            parent,
            leaf,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
        .map_err(StoreError::Io)?;
        hook(HookPoint::AfterLeafOpen);
        if Identity::from_metadata(&file.metadata()?) != expected {
            return Err(invalid());
        }
        let after = stat_at(parent, leaf).map_err(|_| invalid())?;
        if Identity::from_stat(&after) != expected {
            return Err(invalid());
        }
        check_directory_chain(root, &root_file, root_identity, &directories)?;
        hook(HookPoint::BeforeRead);
        // Recheck after the deterministic test seam and immediately before consuming bytes.
        let current = stat_at(parent, leaf).map_err(|_| invalid())?;
        if Identity::from_stat(&current) != expected {
            return Err(invalid());
        }
        let bytes = read_bounded(&mut file, cap)?;
        check_directory_chain(root, &root_file, root_identity, &directories)?;
        let current = stat_at(parent, leaf).map_err(|_| invalid())?;
        if Identity::from_stat(&current) != expected {
            return Err(invalid());
        }
        Ok(Some(bytes))
    }

    fn open_parent_for_removal(
        root: &Path,
        root_file: &File,
        root_identity: Identity,
        components: &[CString],
    ) -> Result<Vec<OpenedDirectory>, StoreError> {
        let mut directories = Vec::with_capacity(components.len().saturating_sub(1));
        for (index, name) in components[..components.len() - 1].iter().enumerate() {
            let parent = directories
                .last()
                .map_or(root_file, |directory: &OpenedDirectory| &directory.file);
            let before = stat_at(parent, name).map_err(StoreError::Io)?;
            let identity = Identity::from_stat(&before);
            if !identity.directory() {
                return Err(invalid());
            }
            let file = open_at(
                parent,
                name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(StoreError::Io)?;
            if Identity::from_metadata(&file.metadata()?) != identity
                || Identity::from_stat(&stat_at(parent, name).map_err(|_| invalid())?) != identity
            {
                return Err(invalid());
            }
            directories.push(OpenedDirectory {
                name: name.clone(),
                file,
                identity,
            });
            check_directory_chain(root, root_file, root_identity, &directories)?;
            let _ = index;
        }
        Ok(directories)
    }

    fn validate_removal(
        root: &Path,
        root_file: &File,
        root_identity: Identity,
        relative: &Path,
    ) -> Result<ValidatedRemoval, StoreError> {
        let components = path_components(relative)?;
        let directories = open_parent_for_removal(root, root_file, root_identity, &components)?;
        let parent = directories
            .last()
            .map_or(root_file, |directory| &directory.file);
        let leaf = components.last().ok_or(StoreError::InvalidName)?.clone();
        let stat = stat_at(parent, &leaf).map_err(StoreError::Io)?;
        let identity = Identity::from_stat(&stat);
        if !identity.regular() {
            return Err(invalid());
        }
        Ok(ValidatedRemoval {
            directories,
            leaf,
            identity,
        })
    }

    fn verify_removal(
        root: &Path,
        root_file: &File,
        root_identity: Identity,
        removal: &ValidatedRemoval,
    ) -> Result<(), StoreError> {
        check_directory_chain(root, root_file, root_identity, &removal.directories)?;
        let parent = removal
            .directories
            .last()
            .map_or(root_file, |directory| &directory.file);
        let stat = stat_at(parent, &removal.leaf).map_err(|_| invalid())?;
        if Identity::from_stat(&stat) != removal.identity {
            return Err(invalid());
        }
        Ok(())
    }

    pub(crate) fn remove_files_under(root: &Path, relatives: &[PathBuf]) -> Result<(), StoreError> {
        remove_files_under_with_hook(root, relatives, |_| {})
    }

    pub(crate) fn remove_files_under_with_hook<F>(
        root: &Path,
        relatives: &[PathBuf],
        mut hook: F,
    ) -> Result<(), StoreError>
    where
        F: FnMut(HookPoint),
    {
        let Some((root_file, root_identity)) = open_root(root, &mut hook)? else {
            return Err(StoreError::InvalidName);
        };
        let mut unique = std::collections::BTreeSet::new();
        let mut validated = Vec::with_capacity(relatives.len());
        for relative in relatives {
            if !unique.insert(relative.clone()) {
                return Err(StoreError::InvalidName);
            }
            validated.push(validate_removal(root, &root_file, root_identity, relative)?);
        }
        hook(HookPoint::AfterRemovalInventory);
        for removal in &validated {
            verify_removal(root, &root_file, root_identity, removal)?;
        }
        for (index, removal) in validated.iter().enumerate() {
            hook(HookPoint::BeforeUnlink(index));
            verify_removal(root, &root_file, root_identity, removal)?;
            let parent = removal
                .directories
                .last()
                .map_or(&root_file, |directory| &directory.file);
            // SAFETY: parent is a held directory FD and leaf is a validated NUL-terminated name.
            let result = unsafe { libc::unlinkat(parent.as_raw_fd(), removal.leaf.as_ptr(), 0) };
            if result < 0 {
                return Err(io::Error::last_os_error().into());
            }
        }
        Ok(())
    }
}

#[cfg(unix)]
pub(super) use unix::{read_capped, read_capped_under, remove_files_under};

#[cfg(test)]
#[cfg(unix)]
pub(crate) use unix::{
    read_capped_under_with_hook, remove_files_under_with_hook, HookPoint as StoreReadHookPoint,
};

#[cfg(not(unix))]
fn unsupported() -> StoreError {
    StoreError::Io(io::Error::new(
        io::ErrorKind::Unsupported,
        "safe descriptor-relative store access is unavailable on this platform",
    ))
}

#[cfg(not(unix))]
pub(super) fn read_capped(_path: &Path, _cap: u64) -> Result<Option<Vec<u8>>, StoreError> {
    Err(unsupported())
}

#[cfg(not(unix))]
pub(super) fn read_capped_under(
    _root: &Path,
    _relative: &Path,
    _cap: u64,
) -> Result<Option<Vec<u8>>, StoreError> {
    Err(unsupported())
}

#[cfg(not(unix))]
pub(super) fn remove_files_under(_root: &Path, _relatives: &[PathBuf]) -> Result<(), StoreError> {
    Err(unsupported())
}

#[cfg(test)]
#[path = "store_read_tests.rs"]
mod tests;
