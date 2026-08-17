use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde_json::json;
use strum::IntoEnumIterator;

#[derive(Debug, Clone, Copy, strum::EnumIter, strum::Display)]
#[strum(serialize_all = "PascalCase")]
enum Browser {
    Chrome,
    #[strum(to_string = "Chrome Canary")]
    ChromeCanary,
    Chromium,
    Edge,
    Firefox,
    Vivaldi,
}

impl Browser {
    fn is_firefox(&self) -> bool {
        matches!(self, Browser::Firefox)
    }
}

fn get_native_message_dir(browser: Browser) -> Option<PathBuf> {
    let home = dirs::home_dir()?;

    if cfg!(target_os = "macos") {
        let relative = match browser {
            Browser::Firefox => "Library/Application Support/Mozilla/NativeMessagingHosts",
            Browser::Chrome | Browser::ChromeCanary => &format!(
                "Library/Application Support/Google/{}/NativeMessagingHosts",
                browser
            ),
            _ => &format!(
                "Library/Application Support/{}/NativeMessagingHosts",
                browser
            ),
        };
        Some(home.join(relative))
    } else if cfg!(target_os = "linux") {
        let relative = match browser {
            Browser::Firefox => ".mozilla/native-messaging-hosts",
            Browser::Chrome | Browser::ChromeCanary => &format!(
                ".config/google-{}/NativeMessagingHosts",
                browser.to_string().to_lowercase().replace(' ', "-")
            ),
            _ => &format!(
                ".config/{}/NativeMessagingHosts",
                browser.to_string().to_lowercase().replace(' ', "-")
            ),
        };
        Some(home.join(relative))
    } else if cfg!(target_os = "windows") {
        let app_data = dirs::data_local_dir()?;
        Some(
            app_data
                .join("NativeMessagingHosts")
                .join(if browser.is_firefox() {
                    "Firefox"
                } else {
                    "Chrome"
                }),
        )
    } else {
        None
    }
}

#[cfg(windows)]
fn write_registry(name: &str, browser: Browser, manifest_path: &Path) -> Result<()> {
    use winreg::{RegKey, enums::*};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key_path = if browser.is_firefox() {
        format!("SOFTWARE\\Mozilla\\NativeMessagingHosts\\{}", name)
    } else {
        format!("SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\{}", name)
    };

    let (key, _) = hkcu
        .create_subkey(&key_path)
        .with_context(|| format!("Failed to create registry key: {}", key_path))?;

    key.set_value("", &manifest_path.to_str().unwrap_or(""))
        .with_context(|| "Failed to set registry default value")?;

    println!(
        "Wrote registry key: HKCU\\{} = {}",
        key_path,
        manifest_path.display()
    );
    Ok(())
}

#[cfg(not(windows))]
fn write_registry(_name: &str, _browser: Browser, _manifest_path: &Path) -> Result<()> {
    Ok(())
}

/// Install native messaging host manifests for all supported browsers.
pub fn install_native_message_host(
    name: &str,
    description: &str,
    chrome_extension_ids: &[&str],
    firefox_extension_ids: &[&str],
) -> Result<()> {
    let exe_path = std::env::current_exe().unwrap_or_default();
    let exe_str = exe_path.to_string_lossy();

    for browser in Browser::iter() {
        let Some(dir) = get_native_message_dir(browser) else {
            println!("Skipping {browser} - cannot determine manifest directory");
            continue;
        };

        fs::create_dir_all(&dir)
            .with_context(|| format!("Failed to create directory: {}", dir.display()))?;

        let mut manifest = json!({
            "name": name,
            "description": description,
            "path": exe_str,
            "type": "stdio"
        });

        if browser.is_firefox() {
            if !firefox_extension_ids.is_empty() {
                manifest["allowed_extensions"] = json!(firefox_extension_ids);
            }
        } else if !chrome_extension_ids.is_empty() {
            let origins: Vec<String> = chrome_extension_ids
                .iter()
                .map(|id| format!("chrome-extension://{}/", id))
                .collect();
            manifest["allowed_origins"] = json!(origins);
        }

        let manifest_path = dir.join(format!("{}.json", name));
        let manifest_json = serde_json::to_string_pretty(&manifest)?;
        fs::write(&manifest_path, &manifest_json)
            .with_context(|| format!("Failed to write manifest: {}", manifest_path.display()))?;

        println!("Wrote manifest for {browser}: {}", manifest_path.display());

        write_registry(name, browser, &manifest_path)?;
    }

    println!("\nNative messaging host installed successfully!\n");

    Ok(())
}
