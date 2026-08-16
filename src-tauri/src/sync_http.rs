use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::time::Duration;

// ─── sync_http.rs — the one place sync is allowed to touch the network ───────
//
// WHY THIS EXISTS AT ALL
//
// The CSP in tauri.conf.json names three hosts in connect-src. A WebDAV URL is
// typed in by the person, so it can never be one of them, and the only way to
// make fetch() reach it is widening connect-src to https://* — which hands every
// other line of frontend code permission to talk to anywhere, in order to enable
// one feature. This file is cheaper than that trade.
//
// WHAT IT DOES NOT DO
//
// It decides nothing. It does not know what WebDAV is, what a bucket is, or
// which statuses mean what. All of that lives in storage.ts, where it is tested
// against fakes and never needs a network to be checked. Everything here is
// conversion: JSON in, bytes out, bytes back, JSON out.
//
// That split is the reason a status code is a normal answer rather than an
// error. 401, 404 and 500 are things the caller knows how to act on, and an
// exception would flatten them into a string. Only a failure to speak at all —
// no route, no TLS, timeout — comes back as Err.

/// Mirrors `RustRequest` in src/lib/sync/transport.ts.
///
/// `rename_all` is not decoration. Tauri converts the *arguments* of a command
/// from camelCase, but not the fields inside a struct, so without this line
/// `bodyB64` arrives as nothing and every request goes out with an empty body —
/// silently, because a PUT with no body is a valid PUT.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    method: String,
    url: String,
    /// A list of pairs rather than a map, so a duplicate header name survives.
    headers: Vec<(String, String)>,
    body_b64: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    status: u16,
    body_b64: String,
}

/// Two kinds, because transport.ts only distinguishes two.
///
/// `config` means the request could not be built from what was given — a URL,
/// a method or a header that is wrong, which is a setting to fix. Anything else
/// is `network`: a condition to survive and retry.
#[derive(Serialize)]
pub struct SyncError {
    kind: &'static str,
    message: String,
}

impl SyncError {
    fn config(message: impl Into<String>) -> Self {
        Self { kind: "config", message: message.into() }
    }
    fn network(message: impl Into<String>) -> Self {
        Self { kind: "network", message: message.into() }
    }
}

#[tauri::command]
pub async fn sync_request(req: SyncRequest) -> Result<SyncResponse, SyncError> {
    // Checked here as well as in storage.ts, because this command is reachable
    // from any frontend code and a scheme like file:// should be refused by the
    // thing holding the credentials, not only by the layer above it.
    let url = reqwest::Url::parse(&req.url)
        .map_err(|e| SyncError::config(format!("{}: {}", req.url, e)))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(SyncError::config(format!("unsupported scheme: {}", url.scheme())));
    }

    // WebDAV needs PROPFIND and MKCOL, which are not in Method's constants, so
    // this parses rather than matching a known list.
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|_| SyncError::config(format!("bad method: {}", req.method)))?;

    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in &req.headers {
        let n = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| SyncError::config(format!("bad header name: {name}")))?;
        // Deliberately does not put the value in the message. One of these is
        // the Authorization header, and an error string ends up on a screen,
        // in a screenshot, and in whatever gets pasted into a chat for help.
        let v = reqwest::header::HeaderValue::from_str(value)
            .map_err(|_| SyncError::config(format!("bad header value for {name}")))?;
        headers.append(n, v);
    }

    // Standard base64, matching what transport.ts encodes with. Not the
    // base64url used in crypto.ts — mixing the two corrupts about one byte in
    // twelve, which looks intermittent and random rather than broken.
    let body = match req.body_b64 {
        Some(ref b64) => Some(
            STANDARD
                .decode(b64)
                .map_err(|e| SyncError::config(format!("body is not base64: {e}")))?,
        ),
        None => None,
    };

    let client = reqwest::Client::builder()
        // Never follow a redirect.
        //
        // A redirect on a PUT is either a server that is set up wrong or
        // somebody standing in the middle. Following it means handing the
        // Authorization header to a host nobody chose, quietly. Better to fail
        // and say so.
        .redirect(reqwest::redirect::Policy::none())
        // A phone gets put in a pocket mid-request and a NAS can go to sleep.
        // Without this the call waits forever and the button spins forever.
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| SyncError::network(e.to_string()))?;

    let mut request = client.request(method, url).headers(headers);
    if let Some(bytes) = body {
        request = request.body(bytes);
    }

    let response = request.send().await.map_err(|e| SyncError::network(e.to_string()))?;

    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        // The status arrived but the body did not. That is still a wire failure
        // rather than an answer, so it must not come back as a valid response
        // with an empty body — an empty PROPFIND reads as "the folder is empty".
        .map_err(|e| SyncError::network(format!("could not read the response body: {e}")))?;

    Ok(SyncResponse { status, body_b64: STANDARD.encode(&bytes) })
}