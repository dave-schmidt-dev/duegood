use super::{generated_context, verify_embedded_asset_set};

#[test]
fn generated_tauri_assets_match_the_frontend_manifest() {
    let context = generated_context();
    let count = verify_embedded_asset_set(context.assets(), context.config())
        .expect("Tauri-generated frontend assets should match the manifest");
    assert!(count > 0);
}
