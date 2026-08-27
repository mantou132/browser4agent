use std::{
    collections::{BTreeMap, HashMap},
    env,
    ffi::OsString,
    fs::{self, File},
    io,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::Mutex as StdMutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::catalog::{AgentCandidate, AgentLaunch, ManagedCli};
use crate::{app_data, logger};

static AGENT_INSTALL_LOCK: StdMutex<()> = StdMutex::new(());
const ACP_REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/// Browsers launched from Finder/Dock only inherit macOS' minimal PATH, which
/// hides CLIs installed under Homebrew or user-local tool managers. Extend the
/// inherited PATH with the usual install locations before probing/launching.
fn user_path_entries() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect())
        .unwrap_or_default();
    if !cfg!(windows) {
        let mut extras = vec![
            PathBuf::from("/opt/homebrew/bin"), // Homebrew on Apple Silicon
            PathBuf::from("/opt/homebrew/sbin"),
            PathBuf::from("/usr/local/bin"), // Homebrew on Intel, npm global
        ];
        if let Some(home) = dirs::home_dir() {
            extras.push(home.join(".local/bin")); // uv/pipx style user installs
            extras.push(home.join(".cargo/bin"));
            extras.push(home.join(".volta/bin"));
            extras.push(home.join("Library/pnpm"));
        }
        for dir in extras {
            if dir.is_dir() && !paths.contains(&dir) {
                paths.push(dir);
            }
        }
    }
    paths
}

fn joined_path(paths: &[PathBuf]) -> Result<OsString> {
    env::join_paths(paths).context("failed to construct the agent PATH")
}

#[cfg(not(windows))]
fn executable_candidates(name: &str) -> Vec<PathBuf> {
    user_path_entries()
        .into_iter()
        .map(|dir| dir.join(name))
        .collect()
}

#[cfg(windows)]
fn executable_candidates(name: &str) -> Vec<PathBuf> {
    let names = if Path::new(name).extension().is_some() {
        vec![OsString::from(name)]
    } else {
        let extensions = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        extensions
            .split(';')
            .filter(|extension| !extension.is_empty())
            .map(|extension| OsString::from(format!("{name}{extension}")))
            .collect()
    };
    let mut candidates = Vec::new();
    for dir in user_path_entries() {
        for name in &names {
            candidates.push(dir.join(name));
        }
    }
    candidates
}

fn executable_command(executable: &Path) -> Command {
    if cfg!(windows)
        && executable.extension().is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/D", "/C"]).arg(executable);
        return cmd;
    }
    Command::new(executable)
}

fn executable_works(executable: &Path, path_entries: &[PathBuf]) -> bool {
    if !executable.is_file() {
        return false;
    }
    let mut command = executable_command(executable);
    command.arg("--version");
    if let Ok(path) = joined_path(path_entries) {
        command.env("PATH", path);
    }
    command
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn find_working_command(name: &str) -> Option<PathBuf> {
    let path_entries = user_path_entries();
    executable_candidates(name)
        .into_iter()
        .find(|executable| executable_works(executable, &path_entries))
}

fn adapter_bin_path(runtime_dir: &Path, adapter_bin: &str) -> PathBuf {
    let name = if cfg!(windows) {
        format!("{adapter_bin}.cmd")
    } else {
        adapter_bin.to_string()
    };
    runtime_dir.join("node_modules").join(".bin").join(name)
}

fn adapter_works(adapter: &Path) -> bool {
    let mut path_entries = user_path_entries();
    if let Some(bin_dir) = adapter.parent()
        && !path_entries.iter().any(|path| path == bin_dir)
    {
        path_entries.push(bin_dir.to_path_buf());
    }
    executable_works(adapter, &path_entries)
}

fn write_runtime_manifest(
    candidate: AgentCandidate,
    runtime_dir: &Path,
    install_managed_cli: bool,
) -> Result<()> {
    let AgentLaunch::Adapter {
        package,
        managed_cli,
        ..
    } = candidate.launch
    else {
        anyhow::bail!("{} does not use an npm ACP adapter", candidate.name);
    };
    let mut dependencies = BTreeMap::from([(package, "latest")]);
    if install_managed_cli && let ManagedCli::NpmPackage(package) = managed_cli {
        dependencies.insert(package, "latest");
    }
    let manifest = serde_json::to_vec_pretty(&serde_json::json!({
        "private": true,
        "dependencies": dependencies,
    }))
    .context("failed to serialize the managed agent package manifest")?;
    let path = runtime_dir.join("package.json");
    if fs::read(&path).ok().as_deref() != Some(manifest.as_slice()) {
        fs::write(&path, manifest).with_context(|| {
            format!(
                "failed to write managed agent package manifest: {}",
                path.display()
            )
        })?;
    }
    Ok(())
}

fn install_adapter(
    candidate: AgentCandidate,
    runtime_dir: &Path,
    require_managed_cli: bool,
) -> Result<PathBuf> {
    let AgentLaunch::Adapter {
        package,
        bin,
        managed_cli,
        ..
    } = candidate.launch
    else {
        anyhow::bail!("{} does not use an npm ACP adapter", candidate.name);
    };
    let adapter = adapter_bin_path(runtime_dir, bin);
    let managed_cli_marker = runtime_dir.join(".managed-cli-installed");
    let managed_cli_works = || match managed_cli {
        ManagedCli::AdapterOptionalDependency => managed_cli_marker.is_file(),
        ManagedCli::NpmPackage(_) => {
            managed_cli_marker.is_file()
                && adapter_works(&adapter_bin_path(runtime_dir, candidate.cli))
        }
    };
    if adapter_works(&adapter) && (!require_managed_cli || managed_cli_works()) {
        return Ok(adapter);
    }

    let _guard = AGENT_INSTALL_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if adapter_works(&adapter) && (!require_managed_cli || managed_cli_works()) {
        return Ok(adapter);
    }
    // Preserve an already provisioned fallback even when a user CLI is
    // currently available and the adapter itself needs repair.
    let install_managed_cli = require_managed_cli || managed_cli_marker.is_file();
    write_runtime_manifest(candidate, runtime_dir, install_managed_cli)?;

    let npm = find_working_command("npm").with_context(|| {
        format!(
            "npm was not found; install Node.js to set up {} automatically",
            candidate.name
        )
    })?;
    logger::info(&format!(
        "Installing {}{} in {}",
        package,
        if install_managed_cli {
            " with its managed CLI"
        } else {
            ""
        },
        runtime_dir.display()
    ));
    let mut command = executable_command(&npm);
    command.args([
        "install",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        "--prefix",
    ]);
    command.arg(runtime_dir).arg(if install_managed_cli {
        "--include=optional"
    } else {
        "--omit=optional"
    });
    command.env("npm_config_cache", app_data::npm_cache_dir()?);
    if let Ok(path) = joined_path(&user_path_entries()) {
        command.env("PATH", path);
    }
    let output = command
        .output()
        .with_context(|| format!("failed to start npm while installing {package}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        anyhow::bail!(
            "npm failed to install {}{}",
            package,
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        );
    }
    if !adapter.is_file() {
        anyhow::bail!(
            "{} was installed without the expected executable: {}",
            package,
            adapter.display()
        );
    }
    if !adapter_works(&adapter) {
        anyhow::bail!(
            "{} was installed but cannot run; ensure Node.js 22 or newer is available",
            package
        );
    }
    if install_managed_cli {
        if let ManagedCli::NpmPackage(cli_package) = managed_cli {
            let cli = adapter_bin_path(runtime_dir, candidate.cli);
            if !adapter_works(&cli) {
                anyhow::bail!(
                    "{} was installed without a working {} executable",
                    cli_package,
                    candidate.cli
                );
            }
        }
        fs::write(&managed_cli_marker, package).with_context(|| {
            format!(
                "failed to record the managed {} CLI installation",
                candidate.name
            )
        })?;
    }
    logger::info(&format!("Installed {package}"));
    Ok(adapter)
}

fn append_program(command: &mut Vec<String>, executable: &Path, args: &[String]) {
    if cfg!(windows)
        && executable.extension().is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
    {
        command.extend(["cmd".to_string(), "/D".to_string(), "/C".to_string()]);
    }
    command.push(executable.to_string_lossy().into_owned());
    command.extend(args.iter().cloned());
}

fn prepare_adapter_command(
    candidate: AgentCandidate,
    user_cli: Option<PathBuf>,
) -> Result<Vec<String>> {
    let AgentLaunch::Adapter {
        cli_override_env,
        managed_cli,
        log_env,
        ..
    } = candidate.launch
    else {
        anyhow::bail!("{} does not use an npm ACP adapter", candidate.name);
    };
    let runtime_dir = app_data::agent_runtime_dir(candidate.id)?;
    let adapter = install_adapter(candidate, &runtime_dir, user_cli.is_none())?;
    let managed_bin_dir = adapter
        .parent()
        .context("managed ACP adapter has no parent directory")?;
    let mut path_entries = user_path_entries();
    if !path_entries.iter().any(|path| path == managed_bin_dir) {
        path_entries.push(managed_bin_dir.to_path_buf());
    }

    let mut command = vec![format!(
        "PATH={}",
        joined_path(&path_entries)?.to_string_lossy()
    )];
    let cli = if let Some(user_cli) = user_cli {
        logger::info(&format!(
            "Using user-installed {} CLI: {}",
            candidate.name,
            user_cli.display()
        ));
        Some(user_cli)
    } else {
        logger::info(&format!(
            "Using managed {} CLI from {}",
            candidate.name,
            runtime_dir.display()
        ));
        match managed_cli {
            ManagedCli::AdapterOptionalDependency => None,
            ManagedCli::NpmPackage(_) => Some(adapter_bin_path(&runtime_dir, candidate.cli)),
        }
    };
    if let (Some(cli_override_env), Some(cli)) = (cli_override_env, cli) {
        command.push(format!("{cli_override_env}={}", cli.to_string_lossy()));
    }
    if let Some(log_env) = log_env {
        let log_dir = app_data::log_dir()?.join(candidate.id);
        fs::create_dir_all(&log_dir).with_context(|| {
            format!("failed to create ACP log directory: {}", log_dir.display())
        })?;
        command.push(format!("{log_env}={}", log_dir.to_string_lossy()));
    }
    append_program(&mut command, &adapter, &[]);
    Ok(command)
}

#[derive(Debug, Deserialize)]
struct Registry {
    agents: Vec<RegistryAgent>,
}

#[derive(Debug, Deserialize)]
struct RegistryAgent {
    id: String,
    version: String,
    distribution: RegistryDistribution,
}

#[derive(Debug, Deserialize)]
struct RegistryDistribution {
    #[serde(default)]
    binary: HashMap<String, RegistryBinary>,
}

#[derive(Debug, Deserialize)]
struct RegistryBinary {
    archive: String,
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedBinaryManifest {
    version: String,
    command: String,
    args: Vec<String>,
}

struct PreparedProgram {
    executable: PathBuf,
    args: Vec<String>,
}

fn registry_platform() -> Result<&'static str> {
    match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => Ok("darwin-aarch64"),
        ("macos", "x86_64") => Ok("darwin-x86_64"),
        ("linux", "aarch64") => Ok("linux-aarch64"),
        ("linux", "x86_64") => Ok("linux-x86_64"),
        ("windows", "aarch64") => Ok("windows-aarch64"),
        ("windows", "x86_64") => Ok("windows-x86_64"),
        (os, arch) => anyhow::bail!("unsupported managed agent platform: {os}-{arch}"),
    }
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf> {
    let mut path = root.to_path_buf();
    let mut has_name = false;
    for component in Path::new(relative).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(name) => {
                path.push(name);
                has_name = true;
            }
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                anyhow::bail!("managed agent command escapes its runtime directory")
            }
        }
    }
    if !has_name {
        anyhow::bail!("managed agent command path is empty");
    }
    Ok(path)
}

fn cached_managed_binary(runtime_dir: &Path) -> Option<PreparedProgram> {
    let manifest: ManagedBinaryManifest =
        serde_json::from_slice(&fs::read(runtime_dir.join("managed-binary.json")).ok()?).ok()?;
    let executable = safe_join(runtime_dir, &manifest.command).ok()?;
    if !executable_works(&executable, &user_path_entries()) {
        return None;
    }
    Some(PreparedProgram {
        executable,
        args: manifest.args,
    })
}

#[cfg(windows)]
fn extract_zip(archive_path: &Path, destination: &Path) -> Result<()> {
    let file = File::open(archive_path)
        .with_context(|| format!("failed to open agent archive: {}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(file).context("failed to read agent zip archive")?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .context("failed to read an entry from the agent zip archive")?;
        let relative = entry
            .enclosed_name()
            .with_context(|| format!("unsafe path in agent archive: {}", entry.name()))?;
        let output_path = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output_path).with_context(|| {
                format!(
                    "failed to create archive directory: {}",
                    output_path.display()
                )
            })?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create archive directory: {}", parent.display())
            })?;
        }
        let mut output = File::create(&output_path).with_context(|| {
            format!("failed to create extracted file: {}", output_path.display())
        })?;
        io::copy(&mut entry, &mut output)
            .with_context(|| format!("failed to extract agent file: {}", output_path.display()))?;
    }
    Ok(())
}

fn extract_agent_archive(archive_path: &Path, archive_url: &str, destination: &Path) -> Result<()> {
    let path = archive_url
        .split('?')
        .next()
        .unwrap_or(archive_url)
        .to_ascii_lowercase();
    #[cfg(unix)]
    if path.ends_with(".tar.gz") || path.ends_with(".tgz") {
        let file = File::open(archive_path)
            .with_context(|| format!("failed to open agent archive: {}", archive_path.display()))?;
        let decoder = flate2::read::GzDecoder::new(file);
        tar::Archive::new(decoder)
            .unpack(destination)
            .context("failed to extract agent tar archive")?;
        return Ok(());
    }
    #[cfg(windows)]
    if path.ends_with(".zip") {
        return extract_zip(archive_path, destination);
    }
    anyhow::bail!("unsupported managed agent archive: {archive_url}")
}

fn install_registry_binary(runtime_dir: &Path, registry_id: &str) -> Result<PreparedProgram> {
    if let Some(program) = cached_managed_binary(runtime_dir) {
        return Ok(program);
    }
    let _guard = AGENT_INSTALL_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(program) = cached_managed_binary(runtime_dir) {
        return Ok(program);
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .user_agent(format!("browser4agent/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .context("failed to create the managed agent downloader")?;
    let response = client
        .get(ACP_REGISTRY_URL)
        .send()
        .context("failed to download the ACP registry")?
        .error_for_status()
        .context("the ACP registry returned an error")?;
    let registry: Registry =
        serde_json::from_reader(response).context("failed to parse the ACP registry")?;
    let agent = registry
        .agents
        .into_iter()
        .find(|agent| agent.id == registry_id)
        .with_context(|| format!("ACP registry has no {registry_id} agent"))?;
    if agent.version.is_empty()
        || agent.version == "."
        || agent.version == ".."
        || !agent
            .version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
    {
        anyhow::bail!("ACP registry returned an unsafe agent version");
    }
    let platform = registry_platform()?;
    let binary = agent
        .distribution
        .binary
        .into_iter()
        .find_map(|(target, binary)| (target == platform).then_some(binary))
        .with_context(|| format!("{registry_id} has no managed binary for {platform}"))?;
    let archive_url = reqwest::Url::parse(&binary.archive)
        .context("ACP registry returned an invalid agent archive URL")?;
    if archive_url.scheme() != "https" {
        anyhow::bail!("managed agent archives must use HTTPS");
    }

    logger::info(&format!(
        "Installing {registry_id} {} from the ACP registry in {}",
        agent.version,
        runtime_dir.display()
    ));
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let install_root = runtime_dir.join(format!(".install-{}-{nonce}", std::process::id()));
    let extracted_dir = install_root.join("extracted");
    let archive_path = install_root.join("agent.archive");
    fs::create_dir_all(&extracted_dir).with_context(|| {
        format!(
            "failed to create managed agent staging directory: {}",
            extracted_dir.display()
        )
    })?;

    let result = (|| {
        let mut response = client
            .get(archive_url)
            .send()
            .context("failed to download the managed agent")?
            .error_for_status()
            .context("the managed agent download returned an error")?;
        let mut archive_file = File::create(&archive_path).with_context(|| {
            format!(
                "failed to create managed agent archive: {}",
                archive_path.display()
            )
        })?;
        io::copy(&mut response, &mut archive_file)
            .context("failed to save the managed agent archive")?;
        drop(archive_file);
        extract_agent_archive(&archive_path, binary.archive.as_str(), &extracted_dir)?;

        let staged_executable = safe_join(&extracted_dir, &binary.cmd)?;
        if !executable_works(&staged_executable, &user_path_entries()) {
            anyhow::bail!(
                "managed {registry_id} was downloaded without a working executable: {}",
                staged_executable.display()
            );
        }
        let versions_dir = runtime_dir.join("versions");
        fs::create_dir_all(&versions_dir).with_context(|| {
            format!(
                "failed to create managed agent versions directory: {}",
                versions_dir.display()
            )
        })?;
        let version_dir = versions_dir.join(&agent.version);
        if version_dir.exists() {
            fs::remove_dir_all(&version_dir).with_context(|| {
                format!(
                    "failed to replace invalid managed agent version: {}",
                    version_dir.display()
                )
            })?;
        }
        fs::rename(&extracted_dir, &version_dir).with_context(|| {
            format!(
                "failed to activate managed agent version: {}",
                version_dir.display()
            )
        })?;
        let executable = safe_join(&version_dir, &binary.cmd)?;
        let relative_command = executable
            .strip_prefix(runtime_dir)
            .context("managed agent executable escaped its runtime directory")?
            .to_string_lossy()
            .into_owned();
        let manifest = ManagedBinaryManifest {
            version: agent.version,
            command: relative_command,
            args: binary.args,
        };
        let manifest_path = runtime_dir.join("managed-binary.json");
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest)
                .context("failed to serialize managed agent metadata")?,
        )
        .with_context(|| {
            format!(
                "failed to write managed agent metadata: {}",
                manifest_path.display()
            )
        })?;
        logger::info(&format!("Installed managed {registry_id}"));
        Ok(PreparedProgram {
            executable,
            args: manifest.args,
        })
    })();
    let _ = fs::remove_dir_all(&install_root);
    result
}

fn prepare_native_command(
    candidate: AgentCandidate,
    user_cli: Option<PathBuf>,
    user_args: &[&str],
    registry_id: &str,
) -> Result<Vec<String>> {
    let program = if let Some(executable) = user_cli {
        logger::info(&format!(
            "Using user-installed {} CLI: {}",
            candidate.name,
            executable.display()
        ));
        PreparedProgram {
            executable,
            args: user_args.iter().map(|arg| (*arg).to_string()).collect(),
        }
    } else {
        let runtime_dir = app_data::agent_runtime_dir(candidate.id)?;
        logger::info(&format!(
            "Using managed {} CLI from {}",
            candidate.name,
            runtime_dir.display()
        ));
        install_registry_binary(&runtime_dir, registry_id)?
    };
    let mut path_entries = user_path_entries();
    if let Some(bin_dir) = program.executable.parent()
        && !path_entries.iter().any(|path| path == bin_dir)
    {
        path_entries.push(bin_dir.to_path_buf());
    }
    let mut command = vec![format!(
        "PATH={}",
        joined_path(&path_entries)?.to_string_lossy()
    )];
    append_program(&mut command, &program.executable, &program.args);
    Ok(command)
}

pub(super) fn prepare_agent_command(candidate: AgentCandidate) -> Result<Vec<String>> {
    let user_cli = find_working_command(candidate.cli);
    match candidate.launch {
        AgentLaunch::Adapter { .. } => prepare_adapter_command(candidate, user_cli),
        AgentLaunch::NativeAcp { args, registry_id } => {
            prepare_native_command(candidate, user_cli, args, registry_id)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{safe_join, write_runtime_manifest};
    use crate::acp_agent::catalog::{AgentLaunch, agent_candidates};

    #[test]
    fn writes_managed_runtime_manifest() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let runtime_dir = std::env::temp_dir().join(format!("browser4agent-runtime-{unique}"));
        std::fs::create_dir_all(&runtime_dir).expect("create runtime directory");
        let candidate = agent_candidates()[0];
        let AgentLaunch::Adapter { package, .. } = candidate.launch else {
            panic!("Claude should use an adapter")
        };

        write_runtime_manifest(candidate, &runtime_dir, false).expect("write runtime manifest");
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(runtime_dir.join("package.json")).expect("read runtime manifest"),
        )
        .expect("parse runtime manifest");
        std::fs::remove_dir_all(&runtime_dir).expect("remove runtime directory");

        assert_eq!(manifest["private"], true);
        assert_eq!(manifest["dependencies"][package], "latest");
    }

    #[test]
    fn managed_pi_manifest_installs_adapter_and_cli_together() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let runtime_dir = std::env::temp_dir().join(format!("browser4agent-pi-{unique}"));
        std::fs::create_dir_all(&runtime_dir).expect("create runtime directory");
        let candidate = agent_candidates()[3];

        write_runtime_manifest(candidate, &runtime_dir, true).expect("write runtime manifest");
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(runtime_dir.join("package.json")).expect("read runtime manifest"),
        )
        .expect("parse runtime manifest");
        std::fs::remove_dir_all(&runtime_dir).expect("remove runtime directory");

        assert_eq!(manifest["dependencies"]["pi-acp"], "latest");
        assert_eq!(
            manifest["dependencies"]["@earendil-works/pi-coding-agent"],
            "latest"
        );
    }

    #[test]
    fn managed_binary_command_stays_inside_runtime() {
        let runtime = std::env::temp_dir().join("browser4agent-runtime-root");
        assert_eq!(
            safe_join(&runtime, "./dist-package/cursor-agent").expect("safe path"),
            runtime.join("dist-package/cursor-agent")
        );
        assert!(safe_join(&runtime, "../cursor-agent").is_err());
        assert!(safe_join(&runtime, "/cursor-agent").is_err());
    }
}
