use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use tauri::webview::{cookie, Cookie};
use tauri::WebviewWindow;

const FILE_NAME: &str = "webview-migration.json";
const SCHEMA_VERSION: u64 = 1;

fn canonical(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(items) => {
            let mut keys = items.keys().collect::<Vec<_>>();
            keys.sort();
            let body = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_owned()),
                        canonical(items.get(key).unwrap_or(&Value::Null))
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
        _ => serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned()),
    }
}

fn checksum_without_field(value: &Value) -> Result<String, String> {
    let mut base = value
        .as_object()
        .ok_or_else(|| "webview migration is not an object".to_owned())?
        .clone();
    base.remove("checksum");
    let canonical = canonical(&Value::Object(base));
    let mut digest = Sha256::new();
    digest.update(canonical.as_bytes());
    Ok(format!("{:x}", digest.finalize()))
}

fn file_path(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join(FILE_NAME)
}

fn marker_path(user_data_dir: &Path) -> std::path::PathBuf {
    user_data_dir.join("webview-migration.completed.json")
}

pub fn initialization_script(user_data_dir: &Path, label: &str) -> String {
    if label != "main" {
        return "(()=>{})();".to_owned();
    }
    let path = file_path(user_data_dir);
    if marker_path(user_data_dir).exists() {
        return "(()=>{})();".to_owned();
    }
    let Ok(text) = fs::read_to_string(path) else {
        return "(()=>{})();".to_owned();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return "(()=>{})();".to_owned();
    };
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION)
        || value.get("source").and_then(Value::as_str) != Some("electron")
    {
        return "(()=>{})();".to_owned();
    }
    let expected = value.get("checksum").and_then(Value::as_str).unwrap_or("");
    let Ok(actual) = checksum_without_field(&value) else {
        return "(()=>{})();".to_owned();
    };
    if expected.len() != 64 || !expected.eq_ignore_ascii_case(&actual) {
        return "(()=>{})();".to_owned();
    }
    let Ok(payload) = serde_json::to_string(&value) else {
        return "(()=>{})();".to_owned();
    };
    let checksum = serde_json::to_string(expected).unwrap_or_else(|_| "\"\"".to_owned());
    format!(
        r#"(async()=>{{
const m={payload};
if(location.protocol!=='http:'||!(/^(127\.0\.0\.1|localhost)$/i.test(location.hostname)))return;
try{{
 for(const [k,v] of Object.entries(m.localStorage||{{}})){{if(localStorage.getItem(k)===null)localStorage.setItem(k,String(v));}}
	 for(const db of (m.indexedDb||[])){{
	  await new Promise((resolve,reject)=>{{const req=indexedDB.open(db.name,db.version);req.onupgradeneeded=()=>{{const d=req.result;for(const s of (db.stores||[]))if(!d.objectStoreNames.contains(s.name))d.createObjectStore(s.name,{{keyPath:s.keyPath===null?undefined:s.keyPath,autoIncrement:!!s.autoIncrement}});}};req.onerror=()=>reject(req.error||new Error('indexeddb open failed'));req.onsuccess=()=>{{const d=req.result;try{{const names=(db.stores||[]).map(s=>s.name);if(!names.length){{d.close();resolve();return;}}const tx=d.transaction(names,'readwrite');for(const s of (db.stores||[])){{const store=tx.objectStore(s.name);for(const r of (s.records||[])){{if(s.keyPath===null)store.put(r.value,r.key);else store.put(r.value);}}}}tx.oncomplete=()=>{{d.close();resolve();}};tx.onerror=()=>reject(tx.error||new Error('indexeddb import failed'));}}catch(e){{reject(e);}}}};}});
 }}
 for(const c of (m.cookies||[])){{if(!c.httpOnly){{let v=encodeURIComponent(c.name)+'='+encodeURIComponent(c.value)+'; path='+(c.path||'/');if(c.domain){{const d=c.domain.replace(/^\./,'');if(d===location.hostname||location.hostname.endsWith('.'+d))v+='; domain='+c.domain;}}document.cookie=v;}}}}
 const t=window.__TAURI_INTERNALS__;if(!t||typeof t.invoke!=='function')throw new Error('tauri invoke unavailable');
 await t.invoke('desktop_migration_complete',{{checksum:{checksum}}});
}}catch(e){{console.warn('[dsh] webview migration deferred',e);}}
}})();"#
    )
}

fn local_cookie_domain(domain: &str, host: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    let host = host.to_ascii_lowercase();
    !domain.is_empty() && (domain == host || host.ends_with(&format!(".{domain}")))
}

fn import_cookie(window: &WebviewWindow, item: &Value, host: &str) -> Result<(), String> {
    let Some(name) = item.get("name").and_then(Value::as_str) else {
        return Err("webview migration cookie has no name".to_owned());
    };
    let Some(value) = item.get("value").and_then(Value::as_str) else {
        return Err(format!("webview migration cookie {name} has no value"));
    };
    let Some(domain) = item.get("domain").and_then(Value::as_str) else {
        return Err(format!("webview migration cookie {name} has no domain"));
    };
    if !local_cookie_domain(domain, host) {
        return Ok(());
    }
    let mut cookie = Cookie::new(name.to_owned(), value.to_owned());
    cookie.set_domain(domain.trim_start_matches('.').to_owned());
    cookie.set_path(
        item.get("path")
            .and_then(Value::as_str)
            .filter(|path| path.starts_with('/'))
            .unwrap_or("/")
            .to_owned(),
    );
    cookie.set_secure(item.get("secure").and_then(Value::as_bool).unwrap_or(false));
    cookie.set_http_only(
        item.get("httpOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    );
    if let Some(same_site) = item.get("sameSite").and_then(Value::as_str) {
        let same_site = match same_site.to_ascii_lowercase().as_str() {
            "strict" => Some(cookie::SameSite::Strict),
            "lax" => Some(cookie::SameSite::Lax),
            "none" => Some(cookie::SameSite::None),
            _ => None,
        };
        cookie.set_same_site(same_site);
    }
    if let Some(seconds) = item.get("expirationDate").and_then(Value::as_f64) {
        if seconds.is_finite() {
            let unix_seconds = seconds.floor() as i64;
            if let Ok(expiration) = cookie::time::OffsetDateTime::from_unix_timestamp(unix_seconds)
            {
                cookie.set_expires(expiration);
            }
        }
    }
    window
        .set_cookie(cookie)
        .map_err(|error| format!("failed to import cookie {name}: {error}"))
}

pub fn complete(
    user_data_dir: &Path,
    window: &WebviewWindow,
    checksum: &str,
) -> Result<Value, String> {
    let path = file_path(user_data_dir);
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("migration file unavailable: {error}"))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|error| format!("migration JSON invalid: {error}"))?;
    let expected = value.get("checksum").and_then(Value::as_str).unwrap_or("");
    if expected != checksum || checksum_without_field(&value)? != checksum {
        return Err("webview migration checksum mismatch".to_owned());
    }
    let host = window
        .url()
        .map_err(|error| format!("cannot determine migration window URL: {error}"))?
        .host_str()
        .filter(|host| *host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost"))
        .ok_or_else(|| "webview migration window is not a loopback HTTP origin".to_owned())?
        .to_owned();
    if let Some(cookies) = value.get("cookies").and_then(Value::as_array) {
        for cookie in cookies {
            import_cookie(window, cookie, &host)?;
        }
    }
    let marker = marker_path(user_data_dir);
    fs::create_dir_all(user_data_dir).map_err(|error| error.to_string())?;
    fs::write(
        &marker,
        serde_json::to_vec(&json!({
            "schemaVersion": SCHEMA_VERSION,
            "checksum": checksum,
            "completedAt": chrono_like_now(),
        }))
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&marker, std::os::unix::fs::PermissionsExt::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    let _ = fs::remove_file(path);
    Ok(json!({ "ok": true, "checksum": checksum }))
}

fn chrono_like_now() -> String {
    // Keep the marker dependency-free; the checksum is the authoritative value.
    format!(
        "unix:{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialization_script_accepts_a_valid_export() {
        let root =
            std::env::temp_dir().join(format!("dsh-tauri-migration-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("migration directory");

        let mut value = json!({
            "schemaVersion": SCHEMA_VERSION,
            "source": "electron",
            "createdAt": "2026-08-22T00:00:00Z",
            "origin": "http://127.0.0.1:43123/",
            "localStorage": {"dsh.sessions.current": "{}"},
            "indexedDb": [],
            "cookies": []
        });
        let checksum = checksum_without_field(&value).expect("checksum");
        value["checksum"] = Value::String(checksum);
        fs::write(file_path(&root), serde_json::to_vec(&value).unwrap()).expect("migration file");

        let script = initialization_script(&root, "main");
        assert!(script.contains("desktop_migration_complete"));
        assert!(script.contains("dsh.sessions.current"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn initialization_script_rejects_tampering_and_honors_completion_marker() {
        let root = std::env::temp_dir().join(format!(
            "dsh-tauri-migration-invalid-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("migration directory");

        let mut value = json!({
            "schemaVersion": SCHEMA_VERSION,
            "source": "electron",
            "createdAt": "2026-08-22T00:00:00Z",
            "origin": "http://127.0.0.1:43123/",
            "localStorage": {},
            "indexedDb": [],
            "cookies": []
        });
        value["checksum"] = Value::String("0".repeat(64));
        fs::write(file_path(&root), serde_json::to_vec(&value).unwrap()).expect("migration file");
        assert!(!initialization_script(&root, "main").contains("desktop_migration_complete"));

        fs::write(marker_path(&root), b"{\"checksum\":\"ignored\"}").expect("marker file");
        assert_eq!(initialization_script(&root, "main"), "(()=>{})();");
        assert_eq!(initialization_script(&root, "float-session"), "(()=>{})();");

        let _ = fs::remove_dir_all(root);
    }
}
