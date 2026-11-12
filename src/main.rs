mod app_data;
mod cli;
mod constant;
mod logger;
mod mcp_server;
mod mcp_setup;
mod native_host;
mod native_message_setup;
mod native_messaging;
mod page_store;
mod peer;
mod skill_setup;

use std::{env, ffi::OsString};

use anyhow::Result;
use dialoguer::Select;

enum LaunchMode {
    Cli(cli::CliArgs),
    /// Launched by a browser as a native messaging host.
    /// Chrome passes `chrome-extension://<id>/`; Firefox passes manifest path +
    /// extension id.
    Browser,
    /// `None` prompts interactively; `Some` comes from `--setup`.
    Setup(Option<SetupChoice>),
}

fn looks_like_browser_launch(args: &[OsString]) -> bool {
    args.iter().skip(1).any(|arg| {
        arg.to_str().is_some_and(|s| {
            s.starts_with("chrome-extension://")
                || s.starts_with("moz-extension://")
                || s.ends_with(".json") // Firefox passes manifest path
        })
    })
}

fn detect_launch_mode() -> Result<Option<LaunchMode>> {
    let args: Vec<OsString> = env::args_os().collect();

    if looks_like_browser_launch(&args) {
        return Ok(Some(LaunchMode::Browser));
    }

    if args.len() > 1 {
        return Ok(cli::parse(args)?.map(|args| match args.setup {
            Some(choice) => LaunchMode::Setup(Some(choice)),
            None => LaunchMode::Cli(args),
        }));
    }

    Ok(Some(LaunchMode::Setup(None)))
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
pub(crate) enum SetupChoice {
    #[value(name = "mcp")]
    InstallMcp,
    #[value(name = "skills")]
    InstallSkills,
    #[value(name = "none")]
    Skip,
}

fn choose_setup_target() -> Result<SetupChoice> {
    let choices = [
        ("Install Skills (Recommend)", SetupChoice::InstallSkills),
        ("Install MCP settings", SetupChoice::InstallMcp),
        ("Skip", SetupChoice::Skip),
    ];
    let index = Select::new()
        .with_prompt("What do you want to install?")
        .items(choices.map(|(label, _)| label))
        .default(0)
        .interact()?;
    Ok(choices[index].1)
}

fn run_setup(choice: Option<SetupChoice>) -> Result<()> {
    native_message_setup::install_native_message_host(
        "browser4agent",
        "Browser for AI Agent",
        &[
            "kaanjpgabaklepokebpdojepkccmbpng",
            "cddjomjjojijahpjngcfebapepdecaff",
            "kgofhkkibnooojbchfppjblmajdcboib",
        ],
        &["browser4agent@xianqiao.wang"],
    )?;

    let choice = match choice {
        Some(choice) => choice,
        None => choose_setup_target()?,
    };
    match choice {
        SetupChoice::InstallMcp => {
            skill_setup::uninstall_skill()?;
            if mcp_setup::setup_mcp()? {
                println!("\nMCP settings installed.");
            } else {
                println!("\nNo supported AI tool was configured.");
            }
        }
        SetupChoice::InstallSkills => {
            mcp_setup::uninstall_mcp()?;
            if skill_setup::install_skill()? {
                println!("\nSkill installed.");
            } else {
                println!("\nNo supported agent was detected for skills.");
            }
        }
        SetupChoice::Skip => {
            println!("Skipped MCP settings and Skills.");
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    match detect_launch_mode()? {
        None => {} // --help was printed
        Some(LaunchMode::Cli(args)) => cli::run(args).await?,
        Some(LaunchMode::Browser) => native_host::run().await?,
        Some(LaunchMode::Setup(choice)) => run_setup(choice)?,
    }
    Ok(())
}
