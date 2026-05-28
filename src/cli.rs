use std::{
    ffi::OsString,
    io::{self, Read},
};

use anyhow::{Context, Result, anyhow, bail};
use clap::{CommandFactory, Parser};
use rmcp::{
    ServiceExt,
    model::{CallToolRequestParams, ClientInfo, RawContent, Tool},
    transport::StreamableHttpClientTransport,
};

use crate::{
    constant::{BIND_ADDRESS, MCP_PATH},
    mcp_server::BrowserMcpServer,
};

#[derive(Debug, Parser)]
#[command(
    name = "browser4agent",
    about = "Forward a single browser4agent tool call to the running MCP HTTP service.",
    after_help = "Pass --help with --tool to print that tool's input schema.\n\nExamples:\n  \
                  browser4agent --tool list_tabs\n  browser4agent --tool read_tab --input \
                  '{\"tab_id\": 123}'\n  echo '{\"tab_id\":123}' | browser4agent --tool read_tab \
                  --stdin\n  browser4agent --tool read_tab --help",
    disable_help_flag = true
)]
pub(crate) struct CliArgs {
    /// Print help. Combine with --tool to print that tool's input schema.
    #[arg(long, short = 'h')]
    help: bool,

    #[arg(long)]
    tool: Option<String>,

    #[arg(long, value_name = "JSON")]
    input: Option<String>,

    #[arg(long)]
    stdin: bool,
}

pub(crate) fn parse(args: Vec<OsString>) -> Result<Option<CliArgs>> {
    Ok(Some(CliArgs::try_parse_from(args)?))
}

pub(crate) async fn run(args: CliArgs) -> Result<()> {
    match (args.help, args.tool.as_deref()) {
        (true, None) => {
            CliArgs::command().print_help()?;
            println!();
            Ok(())
        }
        (true, Some(tool)) => print_tool_help(tool),
        (false, Some(tool)) => call_tool(tool, args.input.as_deref(), args.stdin).await,
        (false, None) => {
            CliArgs::command().print_help()?;
            println!();
            bail!("--tool is required");
        }
    }
}

async fn call_tool(name: &str, inline: Option<&str>, from_stdin: bool) -> Result<()> {
    let input = read_input(inline, from_stdin)?;
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
        .call_tool(CallToolRequestParams::new(name.to_owned()).with_arguments(input))
        .await
        .context("tool call failed")?;
    print_result(&result)?;
    client
        .close()
        .await
        .context("failed to close MCP client session")?;
    Ok(())
}

fn print_tool_help(name: &str) -> Result<()> {
    let tools = BrowserMcpServer::tool_specs();
    let tool = tools.iter().find(|t| t.name == name).ok_or_else(|| {
        let names: Vec<&str> = tools.iter().map(|t| t.name.as_ref()).collect();
        anyhow!(
            "tool '{name}' not found. Available tools:\n  {}",
            names.join("\n  ")
        )
    })?;
    print_tool(tool)
}

fn print_tool(tool: &Tool) -> Result<()> {
    println!("{}\n", tool.name);
    if let Some(desc) = &tool.description {
        println!("{}\n", desc.trim());
    }
    println!("Input schema:");
    println!("{}", serde_json::to_string_pretty(&*tool.input_schema)?);
    println!("\nUsage:");
    println!("  browser4agent --tool {} --input '<json>'", tool.name);
    println!(
        "  echo '<json>' | browser4agent --tool {} --stdin",
        tool.name
    );
    Ok(())
}

fn read_input(
    inline: Option<&str>,
    from_stdin: bool,
) -> Result<serde_json::Map<String, serde_json::Value>> {
    let raw = if from_stdin {
        let mut buf = String::new();
        io::stdin()
            .read_to_string(&mut buf)
            .context("failed to read JSON input from stdin")?;
        buf
    } else if let Some(s) = inline {
        s.to_string()
    } else {
        return Ok(Default::default());
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
