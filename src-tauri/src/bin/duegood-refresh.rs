//! Bundled Canvas refresh helper. The only diagnostic flag reports its fixed store root without
//! accessing credentials, the network, or store contents.

fn main() {
    let mut args = std::env::args_os().skip(1);
    if let Some(first) = args.next() {
        if first == "--report-store-root" && args.next().is_none() {
            match duegood_desktop::refresh_helper_store_root() {
                Ok(root) => {
                    println!("{}", root.display());
                    return;
                }
                Err(_) => {
                    eprintln!("Store root is unavailable.");
                    std::process::exit(1);
                }
            }
        }
        eprintln!("Unsupported helper argument.");
        std::process::exit(2);
    }
    if duegood_desktop::run_refresh_helper().is_err() {
        // The app discards helper stderr and displays only its own generic structured error.
        eprintln!("Canvas refresh failed.");
        std::process::exit(1);
    }
}
