use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub(super) const REGISTRY_JSON: &str = include_str!("registry.json");

#[derive(Clone, Debug)]
pub(super) enum AgentLaunch {
    Binary {
        version: String,
        target: RegistryBinaryTarget,
    },
    Npx {
        package: String,
        args: Vec<String>,
        env: HashMap<String, String>,
    },
    Uvx {
        package: String,
        args: Vec<String>,
        env: HashMap<String, String>,
    },
}

/// A supported agent, its user CLI, and how to launch or provision ACP.
#[derive(Clone, Debug)]
pub(super) struct AgentCandidate {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) cli: Option<String>,
    pub(super) launch: AgentLaunch,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub(super) struct Registry {
    pub(super) version: String,
    pub(super) agents: Vec<RegistryAgent>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub(super) struct RegistryAgent {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) version: String,
    pub(super) description: Option<String>,
    pub(super) icon: Option<String>,
    pub(super) distribution: RegistryDistribution,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub(super) struct RegistryDistribution {
    pub(super) binary: Option<HashMap<String, RegistryBinaryTarget>>,
    pub(super) npx: Option<RegistryNpxTarget>,
    pub(super) uvx: Option<RegistryUvxTarget>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub(super) struct RegistryBinaryTarget {
    pub(super) archive: String,
    pub(super) cmd: String,
    #[serde(default)]
    pub(super) args: Vec<String>,
    #[serde(default)]
    pub(super) env: HashMap<String, String>,
    pub(super) sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub(super) struct RegistryNpxTarget {
    pub(super) package: String,
    #[serde(default)]
    pub(super) args: Vec<String>,
    #[serde(default)]
    pub(super) env: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub(super) struct RegistryUvxTarget {
    pub(super) package: String,
    #[serde(default)]
    pub(super) args: Vec<String>,
    #[serde(default)]
    pub(super) env: HashMap<String, String>,
}

pub(super) fn bundled_registry() -> Result<Registry, serde_json::Error> {
    serde_json::from_str(REGISTRY_JSON)
}

fn registry_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        os => os,
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// Select a distribution for the host before deriving its CLI or launch args.
fn candidates_for_platform(platform: &str) -> Vec<AgentCandidate> {
    let mut candidates = Vec::new();
    if let Ok(registry) = bundled_registry() {
        for agent in registry.agents {
            if let Some(binary) = agent
                .distribution
                .binary
                .and_then(|mut targets| targets.remove(platform))
            {
                // Registry Windows paths can mix '/' and '\\', including when
                // inspecting another platform's catalog in a test.
                let cmd_name = binary.cmd.rsplit(['/', '\\']).next().unwrap_or_default();
                // Let PATHEXT probe both native executables and package-manager
                // shims (for example, kilo.exe or kilo.cmd) on Windows.
                let cmd_name = if platform.starts_with("windows-") {
                    cmd_name
                        .rsplit_once('.')
                        .filter(|(_, extension)| {
                            ["exe", "cmd", "bat", "com"]
                                .iter()
                                .any(|suffix| extension.eq_ignore_ascii_case(suffix))
                        })
                        .map_or(cmd_name, |(name, _)| name)
                } else {
                    cmd_name
                };
                let cli = (!cmd_name.is_empty()).then(|| cmd_name.to_string());
                candidates.push(AgentCandidate {
                    id: agent.id.clone(),
                    name: agent.name,
                    cli,
                    launch: AgentLaunch::Binary {
                        version: agent.version,
                        target: binary,
                    },
                });
            } else if let Some(npx) = agent.distribution.npx {
                candidates.push(AgentCandidate {
                    id: agent.id,
                    name: agent.name,
                    cli: None,
                    launch: AgentLaunch::Npx {
                        package: npx.package,
                        args: npx.args,
                        env: npx.env,
                    },
                });
            } else if let Some(uvx) = agent.distribution.uvx {
                candidates.push(AgentCandidate {
                    id: agent.id,
                    name: agent.name,
                    cli: None,
                    launch: AgentLaunch::Uvx {
                        package: uvx.package,
                        args: uvx.args,
                        env: uvx.env,
                    },
                });
            }
        }
    }
    candidates
}

/// Agents with a usable distribution for this host (binary, then npx/uvx).
pub(super) fn agent_candidates() -> Vec<AgentCandidate> {
    candidates_for_platform(&registry_platform())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableAgent {
    pub id: String,
    pub name: String,
}

pub fn available_agents() -> Vec<AvailableAgent> {
    agent_candidates()
        .into_iter()
        .map(|candidate| AvailableAgent {
            id: candidate.id,
            name: candidate.name,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        AgentLaunch, agent_candidates, available_agents, bundled_registry, candidates_for_platform,
    };

    #[test]
    fn parses_bundled_registry() {
        let registry = bundled_registry().expect("valid bundled registry");
        assert!(!registry.agents.is_empty());
    }

    #[test]
    fn lists_all_available_agents() {
        let agents = available_agents();
        assert_eq!(agents.len(), agent_candidates().len());
    }

    #[test]
    fn candidates_use_the_selected_platform_command() {
        for (platform, cursor_cli, poolside_cli) in [
            ("darwin-aarch64", "cursor-agent", "pool-darwin-arm64"),
            ("windows-x86_64", "cursor-agent", "pool-windows-amd64"),
        ] {
            let candidates = candidates_for_platform(platform);
            for (id, expected) in [("cursor", cursor_cli), ("poolside", poolside_cli)] {
                let candidate = candidates
                    .iter()
                    .find(|candidate| candidate.id == id)
                    .unwrap();
                assert_eq!(candidate.cli.as_deref(), Some(expected));
                assert!(matches!(candidate.launch, AgentLaunch::Binary { .. }));
            }
        }
    }

    #[test]
    fn falls_back_to_npx_when_the_platform_has_no_binary() {
        let candidates = candidates_for_platform("windows-aarch64");
        let kilo = candidates
            .iter()
            .find(|candidate| candidate.id == "kilo")
            .unwrap();
        assert!(
            matches!(&kilo.launch, AgentLaunch::Npx { package, args, .. }
            if package.starts_with("@kilocode/cli@") && args == &["acp"])
        );
        assert!(kilo.cli.is_none());
        assert!(!candidates.iter().any(|candidate| candidate.id == "goose"));
    }
}
