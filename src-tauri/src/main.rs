// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--verify-embedded-assets" {
        match duegood_desktop::verify_embedded_assets() {
            Ok(count) => println!("Verified {count} embedded frontend asset(s)."),
            Err(_) => {
                eprintln!("Embedded frontend asset verification failed.");
                std::process::exit(1);
            }
        }
        return;
    }
    if !args.is_empty() {
        eprintln!("Unsupported Due Good command-line argument.");
        std::process::exit(2);
    }
    duegood_desktop::run();
}
