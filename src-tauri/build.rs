// src-tauri/build.rs

fn main() {
    // Credentials are read from src-tauri/.env at build time and baked in as
    // compile-time environment variables.
    //
    // WHY THIS IS NOT A SECRET, AND WHY IT IS STILL NOT IN THE REPOSITORY
    //
    // RFC 8252 calls a native app a public client and says plainly that it
    // cannot keep a secret: whatever is compiled in can be read back out of the
    // binary with `strings`. Google issues a "client secret" for the Desktop
    // client type anyway, because its token endpoint wants the field.
    //
    // So this file is not hiding anything. What it buys is two real things:
    // the value never enters git history, where deleting it later does not
    // remove it, and it never trips the secret scanners at GitHub and Google.
    //
    // WHY MISSING IS NOT AN ERROR
    //
    // This repository is public. A build that fails for everyone who does not
    // already have the file is a repository nobody can build. Absent
    // credentials are read by oauth_client() as None, and the settings screen
    // goes on saying what it already says — that Drive is written and tested
    // but nothing can sign you in yet.
    println!("cargo:rerun-if-changed=.env");

    if let Ok(text) = std::fs::read_to_string(".env") {
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                let value = value.trim().trim_matches('"');
                // Only this app's own variables, so a stray line in .env cannot
                // set something cargo itself reads.
                if key.starts_with("REUP_") {
                    println!("cargo:rustc-env={key}={value}");
                }
            }
        }
    }

    tauri_build::build()
}