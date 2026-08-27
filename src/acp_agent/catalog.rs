use serde::Serialize;

#[derive(Clone, Copy)]
pub(super) enum ManagedCli {
    /// The ACP adapter declares its compatible CLI as an optional dependency.
    AdapterOptionalDependency,
    /// Install a separate npm CLI package beside the adapter.
    NpmPackage(&'static str),
}

#[derive(Clone, Copy)]
pub(super) enum AgentLaunch {
    Adapter {
        package: &'static str,
        bin: &'static str,
        cli_override_env: Option<&'static str>,
        managed_cli: ManagedCli,
        log_env: Option<&'static str>,
    },
    NativeAcp {
        args: &'static [&'static str],
        registry_id: &'static str,
    },
}

/// A supported agent, its user CLI, and how to launch or provision ACP.
#[derive(Clone, Copy)]
pub(super) struct AgentCandidate {
    pub(super) id: &'static str,
    pub(super) name: &'static str,
    pub(super) cli: &'static str,
    pub(super) launch: AgentLaunch,
}

/// Supported ACP agents in display order.
pub(super) fn agent_candidates() -> [AgentCandidate; 4] {
    [
        AgentCandidate {
            id: "claude",
            name: "Claude Code",
            cli: "claude",
            launch: AgentLaunch::Adapter {
                package: "@agentclientprotocol/claude-agent-acp",
                bin: "claude-agent-acp",
                cli_override_env: Some("CLAUDE_CODE_EXECUTABLE"),
                managed_cli: ManagedCli::AdapterOptionalDependency,
                log_env: None,
            },
        },
        AgentCandidate {
            id: "codex",
            name: "Codex",
            cli: "codex",
            launch: AgentLaunch::Adapter {
                package: "@agentclientprotocol/codex-acp",
                bin: "codex-acp",
                cli_override_env: Some("CODEX_PATH"),
                managed_cli: ManagedCli::AdapterOptionalDependency,
                log_env: Some("APP_SERVER_LOGS"),
            },
        },
        AgentCandidate {
            id: "cursor",
            name: "Cursor",
            cli: "cursor-agent",
            launch: AgentLaunch::NativeAcp {
                args: &["acp"],
                registry_id: "cursor",
            },
        },
        AgentCandidate {
            id: "pi",
            name: "pi",
            cli: "pi",
            launch: AgentLaunch::Adapter {
                package: "pi-acp",
                bin: "pi-acp",
                cli_override_env: Some("PI_ACP_PI_COMMAND"),
                managed_cli: ManagedCli::NpmPackage("@earendil-works/pi-coding-agent"),
                log_env: None,
            },
        },
    ]
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableAgent {
    pub id: &'static str,
    pub name: &'static str,
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
    use super::available_agents;

    #[test]
    fn lists_supported_agents_without_local_cli_detection() {
        let agents = available_agents();
        assert_eq!(
            agents.iter().map(|agent| agent.id).collect::<Vec<_>>(),
            ["claude", "codex", "cursor", "pi"]
        );
    }
}
