/// Geo guard: refuses to touch provider APIs from a blocked country so the
/// user doesn't accidentally get their accounts flagged/logged out.
///
/// The public IP comes from checkip.amazonaws.com (the only service that
/// reliably reports the real egress address); the country is then resolved
/// for that exact IP through a waterfall of geo providers. Fail-safe: if the
/// country can't be determined, refresh is blocked.
use serde_json::Value;
use std::time::Duration;

const BLOCKED_COUNTRIES: &[&str] = &["RU"];
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

pub struct Verdict {
    pub allowed: bool,
    pub country: Option<String>,
    pub ip: Option<String>,
}

pub async fn check(client: &reqwest::Client) -> Verdict {
    let ip = fetch_ip(client).await;
    match fetch_country(client, ip.as_deref()).await {
        Some(cc) => Verdict {
            allowed: !BLOCKED_COUNTRIES.contains(&cc.as_str()),
            country: Some(cc),
            ip,
        },
        None => Verdict {
            allowed: false,
            country: None,
            ip,
        },
    }
}

async fn fetch_ip(client: &reqwest::Client) -> Option<String> {
    let text = get_text(client, "https://checkip.amazonaws.com").await?;
    let ip = text.trim();
    ip.parse::<std::net::IpAddr>().ok().map(|_| ip.to_string())
}

async fn fetch_country(client: &reqwest::Client, ip: Option<&str>) -> Option<String> {
    // When the authoritative IP is known, ask providers about that exact
    // address — some of them see a different egress IP on their own.
    let urls: Vec<String> = match ip {
        Some(ip) => vec![
            format!("https://api.country.is/{ip}"),
            format!("https://get.geojs.io/v1/ip/country/{ip}.json"),
            format!("https://ipwho.is/{ip}"),
            format!("https://ipapi.co/{ip}/json/"),
        ],
        None => vec![
            "https://api.country.is/".into(),
            "https://get.geojs.io/v1/ip/country.json".into(),
            "https://ipwho.is/".into(),
            "https://ipapi.co/json/".into(),
        ],
    };
    for url in urls {
        if let Some(v) = get_json(client, &url).await {
            if let Some(cc) = extract_country(&v) {
                return Some(cc);
            }
        }
    }
    None
}

fn extract_country(v: &Value) -> Option<String> {
    // ipwho.is signals errors with success=false and HTTP 200
    if v.get("success").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let raw = v
        .get("country_code")
        .and_then(Value::as_str)
        .or_else(|| v.get("country").and_then(Value::as_str))?;
    let cc = raw.trim().to_uppercase();
    if cc.len() == 2 && cc.chars().all(|c| c.is_ascii_uppercase()) {
        Some(cc)
    } else {
        None
    }
}

async fn get_text(client: &reqwest::Client, url: &str) -> Option<String> {
    let resp = client
        .get(url)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.text().await.ok()
}

async fn get_json(client: &reqwest::Client, url: &str) -> Option<Value> {
    let resp = client
        .get(url)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json().await.ok()
}
