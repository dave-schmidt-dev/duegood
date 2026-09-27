//! One-request Canvas file downloader. Verifier URLs arrive only over stdin and are never logged.

fn main() {
    if std::env::args_os().len() != 1 {
        eprintln!("invalid-request");
        std::process::exit(2);
    }
    if let Err(code) = duegood_desktop::run_capture_download_helper() {
        eprintln!("{code}");
        std::process::exit(1);
    }
}
