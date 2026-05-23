use std::{
    ffi::OsString,
    io::{self, IsTerminal, Read},
};

use anyhow::{Context, Result, bail};
use clap::Parser;
use rmcp::{
    ServiceExt,
    model::{CallToolRequestParams, ClientInfo, RawContent},
    transport::StreamableHttpClientTransport,
};

use crate::constant::{BIND_ADDRESS, MCP_PATH};

#[derive(Debug, Parser)]
#[command(
    name = "browser4agent",
    about = "Forward a single browser4agent tool call to the running MCP HTTP service.",
    after_help = "Tool schemas live in the installed skill.\n\nExamples:\n  browser4agent --tool list_tabs\n  browser4agent --tool read_tab --input '{\"tab_id\": 123}'\n  echo '{\"tab_id\":123}' | browser4agent --tool read_tab"
)]
pub(crate) struct CliArgs {
    #[arg(long)]
    tool: String,

    #[arg(long, value_name = "JSON")]
    input: Option<String>,
}

pub(crate) fn looks_like_cli(args: &[OsString]) -> bool {
    args.iter()
        .skip(1)
        .any(|arg| arg.to_str().is_some_and(|arg| arg.starts_with('-')))
}

pub(crate) fn parse(args: Vec<OsString>) -> Result<Option<CliArgs>> {
    match CliArgs::try_parse_from(args) {
        Ok(parsed) => Ok(Some(parsed)),
        Err(err) if err.kind() == clap::error::ErrorKind::DisplayHelp => {
            err.print()?;
            Ok(None)
        }
        Err(err) => Err(err.into()),
    }
}

pub(crate) async fn run(args: CliArgs) -> Result<()> {
    let input = read_input(args.input.as_deref())?;
    let url = format!("http://{BIND_ADDRESS}{MCP_PATH}");
    let transport = StreamableHttpClientTransport::from_uri(url);
    let mut client = ClientInfo::default()
        .serve(transport)
        .await
        .with_context(|| {
            format!(
                "failed to connect to running MCP HTTP service at http://{BIND_ADDRESS}{MCP_PATH}"
            )
        })?;

    let result = client
        .call_tool(CallToolRequestParams::new(args.tool).with_arguments(input))
        .await
        .context("tool call failed")?;
    print_result(&result)?;
    client
        .close()
        .await
        .context("failed to close MCP client session")?;
    Ok(())
}

fn read_input(inline: Option<&str>) -> Result<serde_json::Map<String, serde_json::Value>> {
    let raw = match inline {
        Some(s) => s.to_string(),
        None if io::stdin().is_terminal() => return Ok(Default::default()),
        None => {
            let mut buf = String::new();
            io::stdin()
                .read_to_string(&mut buf)
                .context("failed to read JSON input from stdin")?;
            buf
        }
    };
    if raw.trim().is_empty() {
        return Ok(Default::default());
    }
    match serde_json::from_str(&raw).context("failed to parse tool input as JSON")? {
        serde_json::Value::Object(map) => Ok(map),
        _ => bail!("tool input must be a JSON object"),
    }
}

fn print_result(result: &rmcp::model::CallToolResult) -> Result<()> {
    if let Some(value) = &result.structured_content {
        println!("{}", serde_json::to_string_pretty(value)?);
        return Ok(());
    }
    if let [content] = result.content.as_slice() {
        if let RawContent::Text(text) = &content.raw {
            println!("{}", text.text);
            return Ok(());
        }
    }
    println!("{}", serde_json::to_string_pretty(result)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_like_cli_distinguishes_flag_from_browser_launch() {
        let with_flag: Vec<OsString> = ["browser4agent", "--tool", "x"]
            .iter()
            .map(|s| (*s).into())
            .collect();
        let browser_launch: Vec<OsString> = ["browser4agent", "chrome-extension://abc"]
            .iter()
            .map(|s| (*s).into())
            .collect();
        assert!(looks_like_cli(&with_flag));
        assert!(!looks_like_cli(&browser_launch));
    }
}
