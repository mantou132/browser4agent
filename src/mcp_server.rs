use std::sync::{Arc, Mutex};

use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    handler::server::{router::tool::ToolRouter, tool::ToolCallContext, wrapper::Parameters},
    model::*,
    schemars,
    service::RequestContext,
    tool, tool_handler, tool_router,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::peer::Peer;

/// Tools that only work on a Chromium engine (they need `chrome.debugger`);
/// hidden from tools/list unless the extension reports `debuggerAvailable`.
/// Keep in sync with SKILL.md.
const CHROMIUM_ONLY_TOOLS: &[&str] = &["debugger_send_command", "debugger_detach"];

/// Shared by MCP server instructions and the generated CLI Skill so both
/// integrations teach agents the same shortest-path routing rules.
pub(crate) const TOOL_ROUTING_WORKFLOW: &str = r#"1. Prefer a dedicated tool (`read_active_tab`, `read_tab`, `get_cookies`, `get_errors`, `get_local_storage`, `screenshot_tab`, etc.) over either script tool.
2. Resolve the target without redundant reads: for the current page use `read_active_tab` directly; with a reliable tab ID use it directly and call `read_tab` only when page content or page-tool discovery is needed; only use `list_tabs` when the target tab is unknown.
3. For page actions, inspect `tools` from `read_active_tab` / `read_tab`. Each `tools[]` item exposes `toolsetId`, `name`, and `inputSchema`; pass `toolsetId` as `toolset_id`, `name` as `tool_name`, and build `args` from `inputSchema`. Prefer `execute_tab_tool` when a matching tool exists; otherwise use `execute_script`.
4. Reuse the discovered tab and page-tool metadata while the same document remains loaded. Read again after navigation or when a tool is no longer available. A short same-document sequence may be combined into one script call.
5. Use `execute_script_in_background` only for one-shot browser-level operations such as tabs, windows, and downloads. It does not access page DOM, support event-listener callbacks, or keep work alive after the function returns.
6. Use Chromium-only CDP tools only when dedicated tools and page/background scripts cannot provide the required lower-level data, such as network response bodies or protocol diagnostics. Complete follow-up CDP commands before `debugger_detach`."#;

/// Browser-reported capabilities that decide which tools are exposed.
#[derive(Clone, Copy, Debug, Default)]
pub struct Capabilities {
    /// The connected extension runs on a Chromium engine and can serve the
    /// tools in [`CHROMIUM_ONLY_TOOLS`].
    debugger_available: bool,
}

impl Capabilities {
    pub fn from_params(params: &Value) -> Self {
        Self {
            debugger_available: params
                .get("debuggerAvailable")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }
    }
}

pub type SharedCapabilities = Arc<Mutex<Capabilities>>;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TabIdParams {
    #[schemars(
        description = "Target tab ID obtained from read_active_tab, read_tab, list_tabs, or the \
                       browser Agent panel context."
    )]
    pub tab_id: i64,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetCookiesParams {
    #[schemars(description = "Target page URL; cookies for this URL's domain are returned.")]
    pub url: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExecuteScriptParams {
    #[schemars(
        description = "A function that runs inside the tab and returns its result; supports \
                       async. It receives the elements of `args` as its parameters."
    )]
    pub func_str: String,
    #[schemars(
        description = "Target tab ID obtained from read_active_tab, read_tab, list_tabs, or the \
                       browser Agent panel context."
    )]
    pub tab_id: i64,
    #[schemars(
        description = "Array of arguments passed to the function. For example, args=[1,2] calls \
                       func(1, 2)."
    )]
    #[serde(default)]
    pub args: Vec<Value>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExecuteTabToolParams {
    #[schemars(
        description = "Target tab ID returned by the read_active_tab or read_tab call that \
                       discovered this page tool."
    )]
    pub tab_id: i64,
    #[schemars(
        description = "Copy tools[].toolsetId from the read_active_tab or read_tab result into \
                       this field. Required — never guess; names may repeat across toolsets."
    )]
    pub toolset_id: String,
    #[schemars(
        description = "Copy tools[].name from the read_active_tab or read_tab result into this \
                       field. Required — never guess; discover at runtime."
    )]
    pub tool_name: String,
    #[schemars(
        description = "JSON object of arguments. Must match the tool's `inputSchema` from the \
                       read_active_tab or read_tab result. Pass `{}` when the tool takes no \
                       parameters."
    )]
    #[serde(default)]
    pub args: serde_json::Map<String, Value>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExecuteScriptInBackgroundParams {
    #[schemars(
        description = "A function that runs in the extension's background service worker and \
                       returns its result; supports async. It receives the elements of `args` as \
                       its parameters."
    )]
    pub func_str: String,
    #[schemars(
        description = "Array of arguments passed to the function. For example, args=[1,2] calls \
                       func(1, 2)."
    )]
    #[serde(default)]
    pub args: Vec<Value>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DebuggerSendCommandParams {
    #[schemars(
        description = "Target tab ID obtained from read_active_tab, read_tab, list_tabs, or the \
                       browser Agent panel context. The debugging session attaches automatically."
    )]
    pub tab_id: i64,
    #[schemars(
        description = "CDP method name, e.g. Network.enable, Runtime.evaluate, DOM.getDocument."
    )]
    pub method: String,
    #[schemars(
        description = "Command parameters matching the CDP method's spec; omit or pass {} for \
                       parameterless commands like Network.enable."
    )]
    #[serde(default)]
    pub params: Value,
}

#[derive(Clone)]
pub struct BrowserMcpServer {
    peer: Peer,
    caps: SharedCapabilities,
    tool_router: ToolRouter<BrowserMcpServer>,
}

#[tool_router]
impl BrowserMcpServer {
    pub fn new(peer: Peer, caps: SharedCapabilities) -> Self {
        Self {
            peer,
            caps,
            tool_router: Self::tool_router(),
        }
    }

    /// False only when `name` is chromium-only and the connected browser
    /// lacks it (capabilities not reported yet counts as lacking).
    fn tool_available(&self, name: &str) -> bool {
        !CHROMIUM_ONLY_TOOLS.contains(&name)
            || self.caps.lock().expect("lock poisoned").debugger_available
    }

    /// Tool metadata (name / description / input schema) generated by the
    /// `#[tool_router]` macro. Used by skill_setup to render SKILL.md so the
    /// installed skill stays in sync with the MCP server.
    pub fn tool_specs() -> Vec<rmcp::model::Tool> {
        Self::tool_router().list_all()
    }

    #[tool(
        description = "List every open tab in the browser. Returns each tab's id, title, active \
                       flag, last-accessed time, and URL. Use this only when the target tab is \
                       unknown; for the current page use read_active_tab directly."
    )]
    async fn list_tabs(&self) -> Result<CallToolResult, McpError> {
        self.call("list_tabs", json!({})).await
    }

    #[tool(
        description = "Read a condensed HTML snapshot of the given tab. Also returns the page \
                       tools available on this tab. Each tools[] item contains toolsetId, name, \
                       description, and inputSchema for use with execute_tab_tool. Use list_tabs \
                       first only when the target tab ID is unknown."
    )]
    async fn read_tab(
        &self,
        Parameters(p): Parameters<TabIdParams>,
    ) -> Result<CallToolResult, McpError> {
        self.call("read_tab", json!({ "tabId": p.tab_id })).await
    }

    #[tool(
        description = "Read a condensed HTML snapshot of the active tab in the current window. \
                       Returns tabId, title, URL, content, and page tools. Each tools[] item \
                       contains toolsetId, name, description, and inputSchema for use with \
                       execute_tab_tool. Use this when the user asks about \"the current page\" — \
                       no list_tabs or follow-up read_tab is needed first."
    )]
    async fn read_active_tab(&self) -> Result<CallToolResult, McpError> {
        self.call("read_active_tab", json!({})).await
    }

    #[tool(
        description = "Fetch the browser's cookies for the given URL's domain. Use this to access \
                       login-protected pages that aren't currently open in the browser: grab the \
                       cookies, then issue a plain HTTP request with them."
    )]
    async fn get_cookies(
        &self,
        Parameters(p): Parameters<GetCookiesParams>,
    ) -> Result<CallToolResult, McpError> {
        self.call("get_cookies", json!({ "url": p.url })).await
    }

    #[tool(
        description = "Fetch page errors from the given tab: JS exceptions, unhandled promise \
                       rejections, and CSP violations. Use this for debugging."
    )]
    async fn get_errors(
        &self,
        Parameters(p): Parameters<TabIdParams>,
    ) -> Result<CallToolResult, McpError> {
        self.call("get_errors", json!({ "tabId": p.tab_id })).await
    }

    #[tool(
        description = "Run custom JavaScript inside the given tab. Use ONLY after read_tab shows \
                       no matching page tool, or read_active_tab shows none for the current page. \
                       For site-specific actions, prefer execute_tab_tool instead."
    )]
    async fn execute_script(
        &self,
        Parameters(p): Parameters<ExecuteScriptParams>,
    ) -> Result<CallToolResult, McpError> {
        self.call(
            "execute_script",
            json!({
                "tabId": p.tab_id,
                "funcStr": p.func_str,
                "args": p.args,
            }),
        )
        .await
    }

    #[tool(
        description = "Invoke a discovered page tool on the given tab. For the current page, \
                       call read_active_tab directly; with a known tab ID call read_tab; only use \
                       list_tabs first when the target is unknown. From the selected tools[] item, \
                       pass toolsetId as toolset_id, name as tool_name, and args matching \
                       inputSchema exactly. Do not guess. Prefer this over execute_script whenever \
                       the tab has a matching tool. Reuse the discovery result while the same \
                       document is loaded; read again after navigation."
    )]
    async fn execute_tab_tool(
        &self,
        Parameters(p): Parameters<ExecuteTabToolParams>,
    ) -> Result<CallToolResult, McpError> {
        self.call(
            "execute_tab_tool",
            json!({
                "tabId": p.tab_id,
                "toolsetId": p.toolset_id,
                "toolName": p.tool_name,
                "args": p.args,
            }),
        )
        .await
    }

    #[tool(
        description = "Run a JavaScript function in the extension's background service worker and \
                       return its result. Use this for one-shot browser-level operations such as \
                       opening/closing tabs and windows (chrome.tabs.create/remove, \
                       chrome.windows.create/remove) or controlling downloads. Both chrome.* and \
                       browser.* namespaces are proxied for Promise-style calls whose arguments \
                       and results are JSON-serializable. Event-listener callbacks and persistent \
                       background work are not supported; timers are dropped when the function \
                       returns, so await your sleeps. This cannot access page DOM or quit the \
                       browser process. Use debugger_send_command, not browser event listeners, \
                       for Chromium network observation. setTimeout/setInterval (+clear), \
                       queueMicrotask, captured console logs, and basic URL parsing are available. \
                       On Chromium, debuggerEvents(tab_id) returns that tab's { attached, cursor, \
                       events: [{method, params, time, seq}] }, or null before any debugging session."
    )]
    async fn execute_script_in_background(
        &self,
        Parameters(p): Parameters<ExecuteScriptInBackgroundParams>,
    ) -> Result<CallToolResult, McpError> {
        self.call(
            "execute_script_in_background",
            json!({
                "funcStr": p.func_str,
                "args": p.args,
            }),
        )
        .await
    }

    #[tool(
        description = "Read the localStorage of the given tab (long values are truncated). Use \
                       this to inspect the page's locally persisted state."
    )]
    async fn get_local_storage(
        &self,
        Parameters(p): Parameters<TabIdParams>,
    ) -> Result<CallToolResult, McpError> {
        self.call("get_local_storage", json!({ "tabId": p.tab_id }))
            .await
    }

    #[tool(
        description = "Screenshot the given tab and return a base64-encoded PNG. Use list_tabs \
                       first only when its ID is unknown. The target tab is activated \
                       automatically so the screenshot succeeds."
    )]
    async fn screenshot_tab(
        &self,
        Parameters(p): Parameters<TabIdParams>,
    ) -> Result<CallToolResult, McpError> {
        let resp = match self
            .request_extension("screenshot_tab", json!({ "tabId": p.tab_id }))
            .await
        {
            Ok(resp) => resp,
            Err(msg) => return Ok(error_text_result(&msg)),
        };
        if let Some(image) = resp.get("image").and_then(|i| i.as_str()) {
            let format = resp.get("format").and_then(|f| f.as_str()).unwrap_or("png");
            return Ok(CallToolResult::success(vec![Content::image(
                image.to_string(),
                format!("image/{format}"),
            )]));
        }
        Ok(json_result(&resp))
    }

    #[tool(
        description = "(Chromium-only, last resort) Send a raw Chrome DevTools Protocol command \
                       when dedicated tools and page/background scripts cannot provide required \
                       lower-level data such as network response bodies or protocol diagnostics. \
                       Attaches automatically (Chrome shows a yellow debugging banner; fails while \
                       DevTools is open). For event-driven domains: enable the domain, read and \
                       save debuggerEvents(tab_id).cursor as a baseline, trigger the action, then \
                       read debuggerEvents in execute_script_in_background and keep only events \
                       whose seq is at least the baseline. Run required follow-up commands such as \
                       Network.getResponseBody before calling debugger_detach. More domains can be \
                       enabled without re-attaching. Warning: Debugger.pause blocks the page until \
                       Debugger.resume."
    )]
    async fn debugger_send_command(
        &self,
        Parameters(p): Parameters<DebuggerSendCommandParams>,
    ) -> Result<CallToolResult, McpError> {
        self.call(
            "debugger_send_command",
            json!({
                "tabId": p.tab_id,
                "method": p.method,
                "params": p.params,
            }),
        )
        .await
    }

    #[tool(
        description = "(Chromium-only) End the CDP debugging session and dismiss the yellow \
                       banner. Idempotent."
    )]
    async fn debugger_detach(
        &self,
        Parameters(p): Parameters<TabIdParams>,
    ) -> Result<CallToolResult, McpError> {
        self.call("debugger_detach", json!({ "tabId": p.tab_id }))
            .await
    }
}

impl BrowserMcpServer {
    /// Send a request to the extension and convert the response into a
    /// CallToolResult. Failures (extension handler threw, timeout, peer
    /// disconnected) are returned as readable tool text so the LLM sees them.
    async fn call(&self, method: &str, params: Value) -> Result<CallToolResult, McpError> {
        match self.request_extension(method, params).await {
            Ok(resp) => Ok(json_result(&resp)),
            Err(msg) => Ok(error_text_result(&msg)),
        }
    }

    /// Send a request to the extension and wait for the response (30s timeout).
    async fn request_extension(&self, method: &str, params: Value) -> Result<Value, String> {
        match tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.peer.call(method, params),
        )
        .await
        {
            Ok(Ok(resp)) => Ok(resp),
            Ok(Err(err)) => Err(err.to_string()),
            Err(_) => Err("Timeout waiting for browser extension".to_string()),
        }
    }
}

fn error_text_result(msg: &str) -> CallToolResult {
    CallToolResult::success(vec![Content::text(format!("Error: {msg}"))])
}

fn json_result(value: &Value) -> CallToolResult {
    let json = serde_json::to_string_pretty(value).unwrap_or_else(|e| format!("Error: {e}"));
    CallToolResult::success(vec![Content::text(json)])
}

// list_tools / call_tool / get_info are hand-written; the macro only fills
// in the rest (get_tool). Point it at the field instead of rebuilding a
// router per request.
#[tool_handler(router = self.tool_router)]
impl ServerHandler for BrowserMcpServer {
    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(
            self.tool_router
                .list_all()
                .into_iter()
                .filter(|tool| self.tool_available(&tool.name))
                .collect(),
        ))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        // Answer with readable tool text instead of the router's protocol-level
        // "tool not found", so the caller learns why and can adapt.
        if !self.tool_available(&request.name) {
            return Ok(CallToolResult::error(vec![Content::text(
                "Error: this tool requires a Chromium-based browser (Chrome/Edge/Brave).",
            )]));
        }
        self.tool_router
            .call(ToolCallContext::new(self, request, context))
            .await
    }

    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::from_build_env())
            .with_instructions(format!(
                "Control the user's active browser via this MCP server. Use this when built-in \
                 fetch/HTTP cannot access content (login walls, SSO, intranet), or when you need \
                 browser-specific data (cookies, localStorage, errors, screenshots) or web app \
                 interactions (forms, clicks, actions).\n\nTool routing:\n\n{TOOL_ROUTING_WORKFLOW}"
            ))
    }
}

#[cfg(test)]
mod tests {
    use super::{BrowserMcpServer, CHROMIUM_ONLY_TOOLS, TOOL_ROUTING_WORKFLOW};

    #[test]
    fn chromium_only_tools_exist_in_router() {
        let names: Vec<_> = BrowserMcpServer::tool_specs()
            .into_iter()
            .map(|t| t.name.into_owned())
            .collect();
        for name in CHROMIUM_ONLY_TOOLS {
            assert!(
                names.contains(&name.to_string()),
                "{name} is gated as chromium-only but missing from tool_specs"
            );
        }
    }

    #[test]
    fn shared_workflow_covers_dynamic_tool_mapping_and_cdp_fallback() {
        assert!(TOOL_ROUTING_WORKFLOW.contains("toolsetId` as `toolset_id"));
        assert!(TOOL_ROUTING_WORKFLOW.contains("`name` as `tool_name"));
        assert!(TOOL_ROUTING_WORKFLOW.contains("only use `list_tabs`"));
        assert!(TOOL_ROUTING_WORKFLOW.contains("CDP tools only when"));
        assert!(TOOL_ROUTING_WORKFLOW.contains("before `debugger_detach`"));
    }
}
