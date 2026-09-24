//! Native copy action. Tests use a double; only production calls the OS pasteboard.

use std::io;
#[cfg(target_os = "macos")]
use std::io::Write;

#[cfg(target_os = "macos")]
fn write_with_timeout(text: &[u8], timeout: std::time::Duration) -> io::Result<()> {
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::Instant;

    let mut child = Command::new("/usr/bin/pbcopy")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("clipboard is unavailable"))?;
    // A stalled pasteboard can also stall a pipe write, so the writer must not own the timeout.
    let bytes = text.to_vec();
    let writer = thread::spawn(move || stdin.write_all(&bytes));
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let written = writer
                    .join()
                    .map_err(|_| io::Error::other("clipboard writer stopped"))?;
                written?;
                return if status.success() {
                    Ok(())
                } else {
                    Err(io::Error::other("clipboard write failed"))
                };
            }
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(std::time::Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = writer.join();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "clipboard timed out",
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = writer.join();
                return Err(error);
            }
        }
    }
}

/// Clipboard boundary for assignment copy text.
pub trait Clipboard: Send + Sync + 'static {
    fn write_text(&self, text: &str) -> io::Result<()>;
}

/// Fixed macOS pasteboard executable; no shell or webview-supplied command is involved.
pub struct SystemClipboard;

impl Clipboard for SystemClipboard {
    fn write_text(&self, text: &str) -> io::Result<()> {
        #[cfg(target_os = "macos")]
        {
            write_with_timeout(text.as_bytes(), std::time::Duration::from_secs(5))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = text;
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "clipboard is unavailable",
            ))
        }
    }
}

/// Copies bounded text through a supplied implementation.
pub fn copy_text(clipboard: &dyn Clipboard, text: &str) -> io::Result<()> {
    if text.len() > 128 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "copy text is too long",
        ));
    }
    clipboard.write_text(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    struct Double(Mutex<Vec<String>>);
    impl Clipboard for Double {
        fn write_text(&self, text: &str) -> io::Result<()> {
            self.0.lock().unwrap().push(text.to_owned());
            Ok(())
        }
    }
    #[test]
    fn copy_uses_double_only() {
        let clipboard = Double(Mutex::new(Vec::new()));
        copy_text(&clipboard, "Synthetic assignment").unwrap();
        assert_eq!(*clipboard.0.lock().unwrap(), vec!["Synthetic assignment"]);
        assert!(copy_text(&clipboard, &"x".repeat(128 * 1024 + 1)).is_err());
    }
}
