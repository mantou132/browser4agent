use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

pub(super) const REGISTRY_JSON: &str = include_str!("registry.json");

#[derive(Clone, Debug)]
pub(super) enum AgentLaunch {
    Binary {
        registry_id: String,
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

/// Supported ACP agents directly from the bundled registry.
pub(super) fn agent_candidates() -> Vec<AgentCandidate> {
    let mut candidates = Vec::new();
    if let Ok(registry) = bundled_registry() {
        for agent in registry.agents {
            if let Some(binary) = &agent.distribution.binary {
                let cli = binary.values().next().and_then(|b| {
                    let cmd_name = Path::new(&b.cmd).file_name()?.to_string_lossy().to_string();
                    let trimmed = cmd_name.trim_end_matches(".exe");
                    (!trimmed.is_empty()).then(|| trimmed.to_string())
                });
                candidates.push(AgentCandidate {
                    id: agent.id.clone(),
                    name: agent.name,
                    cli,
                    launch: AgentLaunch::Binary {
                        registry_id: agent.id,
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
    use super::{agent_candidates, available_agents, bundled_registry};

    #[test]
    fn parses_bundled_registry() {
        let registry = bundled_registry().expect("valid bundled registry");
        assert!(!registry.agents.is_empty());
    }

    #[test]
    fn lists_all_available_agents() {
        let agents = available_agents();
        assert_eq!(agents.len(), bundled_registry().unwrap().agents.len());
    }

    #[test]
    fn candidates_include_all_registry_agents() {
        let candidates = agent_candidates();
        let registry = bundled_registry().expect("valid bundled registry");
        assert_eq!(candidates.len(), registry.agents.len());
    }
}
