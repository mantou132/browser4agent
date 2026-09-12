use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    fs::{self, File},
    io,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::Mutex as StdMutex,
    time::Duration,
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::catalog::{AgentCandidate, AgentLaunch, RegistryBinaryTarget};
use crate::{app_data, logger};

static AGENT_INSTALL_LOCK: StdMutex<()> = StdMutex::new(());

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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedBinaryManifest {
    version: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

struct PreparedProgram {
    executable: PathBuf,
    args: Vec<String>,
    env: HashMap<String, String>,
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

fn cached_managed_binary(runtime_dir: &Path, version: &str) -> Option<PreparedProgram> {
    let manifest_bytes = fs::read(runtime_dir.join("managed-binary.json")).ok()?;
    let manifest: ManagedBinaryManifest = serde_json::from_slice(&manifest_bytes).ok()?;
    if manifest.version != version {
        return None;
    }
    let executable = safe_join(runtime_dir, &manifest.command).ok()?;
    if !executable.is_file() {
        return None;
    }
    Some(PreparedProgram {
        executable,
        args: manifest.args,
        env: manifest.env,
    })
}

fn extract_zip(archive_path: &Path, destination: &Path) -> Result<()> {
    let file = File::open(archive_path)
        .with_context(|| format!("failed to open agent archive: {}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .with_context(|| format!("failed to read zip archive: {}", archive_path.display()))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .context("failed to read zip entry")?;
        let Some(enclosed_name) = entry.enclosed_name() else {
            continue;
        };
        let output_path = destination.join(enclosed_name);
        if entry.is_dir() {
            fs::create_dir_all(&output_path).with_context(|| {
                format!("failed to create directory: {}", output_path.display())
            })?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create parent directory: {}", parent.display())
            })?;
        }
        let mut output = File::create(&output_path).with_context(|| {
            format!("failed to create extracted file: {}", output_path.display())
        })?;
        io::copy(&mut entry, &mut output)
            .with_context(|| format!("failed to extract agent file: {}", output_path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                let _ = fs::set_permissions(&output_path, fs::Permissions::from_mode(mode));
            }
        }
    }
    Ok(())
}

fn extract_agent_archive(archive_path: &Path, archive_url: &str, destination: &Path) -> Result<()> {
    let path = archive_url.split('?').next().unwrap_or(archive_url);
    if path.ends_with(".tar.gz") || path.ends_with(".tgz") {
        let file = File::open(archive_path)
            .with_context(|| format!("failed to open agent archive: {}", archive_path.display()))?;
        let tar = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(tar);
        archive
            .unpack(destination)
            .context("failed to extract agent tar archive")?;
        return Ok(());
    }
    if path.ends_with(".zip") {
        return extract_zip(archive_path, destination);
    }
    #[cfg(unix)]
    if path.ends_with(".tar.bz2") || path.ends_with(".tbz") {
        let status = std::process::Command::new("tar")
            .arg("-xjf")
            .arg(archive_path)
            .arg("-C")
            .arg(destination)
            .status()
            .context("failed to run tar -xjf")?;
        if !status.success() {
            anyhow::bail!("tar -xjf failed with status: {status}");
        }
        return Ok(());
    }
    // Single uncompressed binary or .exe
    let file_name = Path::new(&path).file_name().unwrap_or_default();
    let dest_file = destination.join(file_name);
    fs::copy(archive_path, &dest_file).context("failed to copy agent binary")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dest_file, fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

fn install_registry_binary(
    runtime_dir: &Path,
    registry_id: &str,
    version: &str,
    binary: &RegistryBinaryTarget,
) -> Result<PreparedProgram> {
    let _guard = AGENT_INSTALL_LOCK
        .lock()
        .expect("agent install lock poisoned");

    if let Some(program) = cached_managed_binary(runtime_dir, version) {
        logger::info(&format!("Reusing cached managed {registry_id} binary"));
        return Ok(program);
    }

    let archive_url = reqwest::Url::parse(&binary.archive)
        .context("ACP registry returned an invalid agent archive URL")?;

    let version_dir = runtime_dir.join("versions").join(version);
    let install_root = runtime_dir
        .join("install")
        .join(format!("{registry_id}-{version}"));
    let unpack_dir = install_root.join("unpack");
    let downloaded_archive = install_root.join(
        archive_url
            .path_segments()
            .and_then(|segments| segments.last())
            .filter(|last| !last.is_empty())
            .unwrap_or("agent-archive"),
    );

    let _ = fs::remove_dir_all(&install_root);
    fs::create_dir_all(&unpack_dir).with_context(|| {
        format!(
            "failed to create managed agent install directory: {}",
            unpack_dir.display()
        )
    })?;

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .user_agent(format!("browser4agent/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .context("failed to create the managed agent downloader")?;

    let result = (|| {
        let mut response = client
            .get(archive_url)
            .send()
            .context("failed to download the managed agent binary")?
            .error_for_status()
            .context("the agent download returned an error")?;
        let mut archive_file = File::create(&downloaded_archive).with_context(|| {
            format!(
                "failed to create download file: {}",
                downloaded_archive.display()
            )
        })?;
        io::copy(&mut response, &mut archive_file)
            .context("failed to save the managed agent archive")?;
        archive_file
            .sync_all()
            .context("failed to flush the agent archive to disk")?;

        logger::info(&format!(
            "Extracting managed {registry_id} binary to {}",
            unpack_dir.display()
        ));
        extract_agent_archive(&downloaded_archive, &binary.archive, &unpack_dir)?;

        let source_executable = safe_join(&unpack_dir, &binary.cmd)?;
        if !source_executable.is_file() {
            anyhow::bail!(
                "managed agent archive did not extract the expected executable: {}",
                source_executable.display()
            );
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&source_executable, fs::Permissions::from_mode(0o755));
        }

        if version_dir.is_dir() {
            let _ = fs::remove_dir_all(&version_dir);
        }
        if let Some(parent) = version_dir.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!(
                    "failed to create runtime version parent directory: {}",
                    parent.display()
                )
            })?;
        }
        fs::rename(&unpack_dir, &version_dir).with_context(|| {
            format!("failed to move managed agent to {}", version_dir.display())
        })?;

        let executable = safe_join(&version_dir, &binary.cmd)?;
        let relative_command = executable
            .strip_prefix(runtime_dir)
            .context("failed to construct the managed agent relative command")?
            .to_string_lossy()
            .into_owned();

        let manifest = ManagedBinaryManifest {
            version: version.to_string(),
            command: relative_command,
            args: binary.args.clone(),
            env: binary.env.clone(),
        };
        let manifest_path = runtime_dir.join("managed-binary.json");
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest)
                .context("failed to serialize the managed agent manifest")?,
        )
        .with_context(|| {
            format!(
                "failed to write managed agent manifest: {}",
                manifest_path.display()
            )
        })?;

        Ok(PreparedProgram {
            executable,
            args: manifest.args,
            env: manifest.env,
        })
    })();
    let _ = fs::remove_dir_all(&install_root);
    result
}

fn prepare_native_command(
    candidate: &AgentCandidate,
    user_cli: Option<PathBuf>,
    version: &str,
    binary: &RegistryBinaryTarget,
) -> Result<Vec<String>> {
    let program = if let Some(executable) = user_cli {
        logger::info(&format!(
            "Using user-installed {} CLI: {}",
            candidate.name,
            executable.display()
        ));
        PreparedProgram {
            executable,
            args: binary.args.clone(),
            env: binary.env.clone(),
        }
    } else {
        let runtime_dir = app_data::agent_runtime_dir(&candidate.id)?;
        logger::info(&format!(
            "Using managed {} CLI from {}",
            candidate.name,
            runtime_dir.display()
        ));
        install_registry_binary(&runtime_dir, &candidate.id, version, binary)?
    };

    let path_entries = user_path_entries();
    let mut command = vec![format!(
        "PATH={}",
        joined_path(&path_entries)?.to_string_lossy()
    )];
    for (k, v) in &program.env {
        command.push(format!("{k}={v}"));
    }
    append_program(&mut command, &program.executable, &program.args);
    Ok(command)
}

fn prepare_npx_command(
    candidate: &AgentCandidate,
    package: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> Result<Vec<String>> {
    let npx = find_working_command("npx").with_context(|| {
        format!(
            "npx was not found; install Node.js to run {} ({})",
            candidate.name, candidate.id
        )
    })?;
    let path_entries = user_path_entries();
    let mut command = vec![format!(
        "PATH={}",
        joined_path(&path_entries)?.to_string_lossy()
    )];
    for (k, v) in env {
        command.push(format!("{k}={v}"));
    }
    let mut npx_args = vec!["-y".to_string(), package.to_string()];
    npx_args.extend(args.iter().cloned());
    append_program(&mut command, &npx, &npx_args);
    Ok(command)
}

fn prepare_uvx_command(
    candidate: &AgentCandidate,
    package: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> Result<Vec<String>> {
    let uvx = find_working_command("uvx").with_context(|| {
        format!(
            "uvx was not found; install uv (Python package runner) to run {} ({})",
            candidate.name, candidate.id
        )
    })?;
    let path_entries = user_path_entries();
    let mut command = vec![format!(
        "PATH={}",
        joined_path(&path_entries)?.to_string_lossy()
    )];
    for (k, v) in env {
        command.push(format!("{k}={v}"));
    }
    let mut uvx_args = vec![package.to_string()];
    uvx_args.extend(args.iter().cloned());
    append_program(&mut command, &uvx, &uvx_args);
    Ok(command)
}

pub(super) fn prepare_agent_command(candidate: AgentCandidate) -> Result<Vec<String>> {
    let user_cli = candidate.cli.as_deref().and_then(find_working_command);
    match &candidate.launch {
        AgentLaunch::Binary { version, target } => {
            prepare_native_command(&candidate, user_cli, version, target)
        }
        AgentLaunch::Npx { package, args, env } => {
            prepare_npx_command(&candidate, package, args, env)
        }
        AgentLaunch::Uvx { package, args, env } => {
            prepare_uvx_command(&candidate, package, args, env)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{cached_managed_binary, extract_agent_archive, safe_join};

    #[test]
    fn extracts_tar_gz_zip_and_standalone_agents() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("browser4agent-archives-{unique}"));
        std::fs::create_dir_all(&root).unwrap();
        let content = b"agent fixture";
        let executable = "bin/agent.exe";

        let archive_path = root.join("agent.tar.gz");
        let gzip = flate2::write::GzEncoder::new(
            std::fs::File::create(&archive_path).unwrap(),
            flate2::Compression::default(),
        );
        let mut archive = tar::Builder::new(gzip);
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        archive
            .append_data(&mut header, executable, &content[..])
            .unwrap();
        archive.into_inner().unwrap().finish().unwrap();
        let destination = root.join("tar");
        extract_agent_archive(
            &archive_path,
            "https://example.com/agent.tar.gz?download=1",
            &destination,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(destination.join(executable)).unwrap(),
            content
        );

        let archive_path = root.join("agent.zip");
        let mut archive = zip::ZipWriter::new(std::fs::File::create(&archive_path).unwrap());
        archive
            .start_file(executable, zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(content).unwrap();
        archive.finish().unwrap();
        let destination = root.join("zip");
        extract_agent_archive(&archive_path, "https://example.com/agent.zip", &destination)
            .unwrap();
        assert_eq!(
            std::fs::read(destination.join(executable)).unwrap(),
            content
        );

        let archive_path = root.join("agent.exe");
        std::fs::write(&archive_path, content).unwrap();
        let destination = root.join("standalone");
        std::fs::create_dir_all(&destination).unwrap();
        extract_agent_archive(&archive_path, "https://example.com/agent.exe", &destination)
            .unwrap();
        assert_eq!(
            std::fs::read(destination.join("agent.exe")).unwrap(),
            content
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_binary_command_stays_inside_runtime() {
        let runtime = std::env::temp_dir().join("browser4agent-runtime-root");
        assert_eq!(
            safe_join(&runtime, "./dist-package/cursor-agent").expect("safe path"),
            runtime.join("dist-package").join("cursor-agent")
        );
    }

    #[test]
    fn loads_cached_managed_binary_manifest() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let runtime_dir = std::env::temp_dir().join(format!("browser4agent-cursor-{unique}"));
        let binary_dir = runtime_dir.join("versions").join("1.0.0");
        std::fs::create_dir_all(&binary_dir).expect("create binary directory");
        let executable = binary_dir.join(if cfg!(windows) {
            "cursor.cmd"
        } else {
            "cursor"
        });
        std::fs::write(&executable, "").expect("write stub executable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755))
                .expect("mark stub executable");
        }
        let manifest = serde_json::json!({
            "version": "1.0.0",
            "command": executable.strip_prefix(&runtime_dir).unwrap().to_string_lossy(),
            "args": ["acp"],
            "env": { "TEST_ENV": "1" }
        });
        std::fs::write(
            runtime_dir.join("managed-binary.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .expect("write binary manifest");

        let cached = cached_managed_binary(&runtime_dir, "1.0.0").expect("find cached binary");
        assert!(cached_managed_binary(&runtime_dir, "2.0.0").is_none());
        std::fs::remove_dir_all(&runtime_dir).expect("remove runtime directory");

        assert_eq!(cached.executable, executable);
        assert_eq!(cached.args, vec!["acp".to_string()]);
        assert_eq!(cached.env.get("TEST_ENV"), Some(&"1".to_string()));
    }
}
