// src-tauri/src/oauth_loopback.rs
//
// ─── the one thing a webview cannot do ───────────────────────────────────────
//
// Google finished off the copy-a-code-out-of-the-browser flow in 2022, so an
// installed app has exactly one way to receive an authorisation code: bind a
// port on 127.0.0.1, send the person to their browser, and read the redirect
// off the socket. That is the whole job of this file.
//
// WHAT IS DELIBERATELY NOT HERE
//
// No PKCE, no URL building, no reading of the query string. Those live in
// src/lib/sync/oauth.ts, whose twin is shared/.../sync/OAuth.kt, and the two are
// held together by a cross-check. Writing them a third time in Rust would mean
// three copies of one decision, which is the disease this project has spent a
// month treating. This file is handed a URL and hands back a URL. It does not
// know what OAuth is, in the same way sync_http.rs does not know what a batch
// is.
//
// WHY std AND NOT tauri-plugin-oauth
//
// The plugin does exactly this and is perfectly good. It is also a dependency
// whose version has to be kept in step with Tauri's, for sixty lines that use
// nothing outside std::net. The trade is worth taking the other way round.

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::time::Duration;

/// What the listener heard.
#[derive(serde::Serialize)]
pub struct Redirect {
    /// The full request target, e.g. `/callback?code=...&state=...`.
    ///
    /// Returned raw and unparsed on purpose: parsing it, including the state
    /// check that makes it safe to act on, is oauth.ts's job.
    pub url: String,
}

/// Bind a loopback port and report which one.
///
/// Port 0 asks the OS for any free port. A fixed port would be one more thing
/// that can already be taken by something else on a machine that has Docker,
/// WSL2 and a dev server on it — and the failure would arrive as "sign-in does
/// not work" rather than as "port busy".
///
/// Google's Desktop client type accepts any loopback port without it being
/// registered in advance, which is what makes this safe to choose at runtime.
#[tauri::command]
pub fn oauth_listen() -> Result<u16, String> {
    let listener = bind()?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("could not read the port back: {e}"))?
        .port();
    // Hand the listener to a thread that will be woken by oauth_wait. Keeping
    // it alive between the two calls is the point: binding inside the wait
    // would leave a window where the browser can arrive before anyone listens.
    LISTENER.with(|slot| *slot.borrow_mut() = Some(listener));
    Ok(port)
}

thread_local! {
    static LISTENER: std::cell::RefCell<Option<TcpListener>> =
        const { std::cell::RefCell::new(None) };
}

fn bind() -> Result<TcpListener, String> {
    // 127.0.0.1 rather than 0.0.0.0. Binding all interfaces would put the
    // redirect — and therefore the authorisation code — on the local network
    // for the length of the sign-in.
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0);
    TcpListener::bind(addr).map_err(|e| format!("could not open a local port: {e}"))
}

/// Wait for the browser to come back, once.
///
/// `timeout_secs` exists because a person who closes the tab without deciding
/// leaves this blocked forever, and a thread blocked forever is a process that
/// will not quit when they press quit.
#[tauri::command]
pub fn oauth_wait(timeout_secs: u64, done_page: String) -> Result<Redirect, String> {
    let listener = LISTENER
        .with(|slot| slot.borrow_mut().take())
        .ok_or_else(|| "oauth_wait was called before oauth_listen".to_string())?;

    listener
        .set_nonblocking(false)
        .map_err(|e| format!("could not configure the local port: {e}"))?;

    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);

    loop {
        if std::time::Instant::now() >= deadline {
            return Err("the browser did not come back in time".into());
        }
        let (stream, _) = listener
            .accept()
            .map_err(|e| format!("the local port stopped listening: {e}"))?;

        match handle(stream, &done_page) {
            // A browser will often fetch /favicon.ico on the same connection
            // burst. Answering it and carrying on is the difference between
            // this working and this returning a redirect with no code in it.
            Ok(Some(url)) => return Ok(Redirect { url }),
            Ok(None) => continue,
            Err(_) => continue,
        }
    }
}

fn handle(mut stream: TcpStream, done_page: &str) -> std::io::Result<Option<String>> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut first = String::new();
    BufReader::new(
        stream.try_clone()?,
    )
    .read_line(&mut first)?;

    // "GET /callback?code=...&state=... HTTP/1.1"
    let target = first.split_whitespace().nth(1).unwrap_or("").to_string();

    if target.starts_with("/favicon.ico") {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return Ok(None);
    }

    let body = done_page.as_bytes();
    let head = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();

    if target.is_empty() {
        return Ok(None);
    }
    Ok(Some(target))
}

/// Whether this build was given credentials at all.
///
/// `option_env!` and not `env!`: `env!` fails the build when the variable is
/// absent, which would mean nobody can clone this repository and build it. This
/// returns None instead, and the settings screen keeps saying what it already
/// says — that Drive is written and tested but nothing can sign you in yet.
#[tauri::command]
pub fn oauth_client() -> Option<(String, String)> {
    let id = option_env!("REUP_GOOGLE_CLIENT_ID")?;
    let secret = option_env!("REUP_GOOGLE_CLIENT_SECRET")?;
    if id.is_empty() || secret.is_empty() {
        return None;
    }
    Some((id.to_string(), secret.to_string()))
}