use crate::native_host::NativeMessenger;
use rmcp::{
    ErrorData as McpError, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{ErrorCode, *},
    schemars, tool, tool_handler, tool_router,
};
use serde::Deserialize;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadTabParams {
    #[schemars(description = "要读取内容的标签页 ID（从 list_tabs 获取）")]
    pub tab_id: i64,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetCookiesParams {
    #[schemars(description = "目标页面的 URL，用于获取该域名下的 cookie")]
    pub url: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetErrorsParams {
    #[schemars(description = "要获取页面错误的标签页 ID（从 list_tabs 获取）")]
    pub tab_id: i64,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExecuteScriptParams {
    #[schemars(description = "一个无参数的函数，该函数在标签页中执行后返回其结果，支持异步函数")]
    pub func_str: String,
    #[schemars(description = "目标标签页 ID（从 list_tabs 获取）")]
    pub tab_id: i64,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExecuteScriptInBackgroundParams {
    #[schemars(
        description = "一个无参数的函数，该函数在扩展背景脚本中执行后返回其结果，支持异步函数"
    )]
    pub func_str: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetLocalStorageParams {
    #[schemars(description = "目标标签页 ID（从 list_tabs 获取）")]
    pub tab_id: i64,
}

#[derive(Clone)]
pub struct BrowserDataServer {
    messenger: NativeMessenger,
    #[allow(dead_code)]
    tool_router: ToolRouter<BrowserDataServer>,
}

#[tool_router]
impl BrowserDataServer {
    pub fn new(messenger: NativeMessenger) -> Self {
        Self {
            messenger,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        description = "列出浏览器中所有打开的标签页，返回每个标签的 id、标题、活动状态、最近使用时间和 URL。用于选择目标标签后再调用 read_tab/get_cookies/get_local_storage 等读取内容。"
    )]
    async fn list_tabs(&self) -> Result<CallToolResult, McpError> {
        let resp = self
            .request_extension(&serde_json::json!({"type": "list_tabs"}))
            .await?;
        if let Some(r) = Self::check_error(&resp) {
            return Ok(r);
        }
        Self::json_result(&resp)
    }

    #[tool(
        description = "读取指定标签页的精简 HTML。先用 list_tabs 获取标签 ID，再用此工具读取内容。"
    )]
    async fn read_tab(
        &self,
        Parameters(params): Parameters<ReadTabParams>,
    ) -> Result<CallToolResult, McpError> {
        let resp = self
            .request_extension(&serde_json::json!({"type": "read_tab", "tabId": params.tab_id}))
            .await?;
        if let Some(r) = Self::check_error(&resp) {
            return Ok(r);
        }
        Self::json_result(&resp)
    }

    #[tool(
        description = "读取当前窗口活动标签页的精简 HTML。当用户直接要求获取当前页面内容时使用，无需先调用 list_tabs。"
    )]
    async fn read_active_tab(&self) -> Result<CallToolResult, McpError> {
        let resp = self
            .request_extension(&serde_json::json!({"type": "read_active_tab"}))
            .await?;
        if let Some(r) = Self::check_error(&resp) {
            return Ok(r);
        }
        Self::json_result(&resp)
    }

    #[tool(
        description = "获取指定 URL 域名下的浏览器 cookie。用于访问需要登录但未在浏览器中打开的页面：先获取 cookie，再用 cookie 发起 HTTP 请求。"
    )]
    async fn get_cookies(
        &self,
        Parameters(params): Parameters<GetCookiesParams>,
    ) -> Result<CallToolResult, McpError> {
        let resp = self
            .request_extension(&serde_json::json!({"type": "get_cookies", "url": params.url}))
            .await?;
        if let Some(r) = Self::check_error(&resp) {
            return Ok(r);
        }
        Self::json_result(&resp)
    }

    #[tool(
        description = "获取指定标签页的页面错误，包括 JS 错误、未处理的 Promise rejection 和 CSP 违规。用于调试页面问题。"
    )]
    async fn get_errors(
        &self,
        Parameters(params): Parameters<GetErrorsParams>,
    ) -> Result<CallToolResult, McpError> {
        let resp = self
            .request_extension(&serde_json::json!({"type": "get_errors", "tabId": params.tab_id}))
            .await?;
        if let Some(r) = Self::check_error(&resp) {
            return Ok(r);
        }
        Self::json_result(&resp)
    }

    #[tool(
        description = "在指定标签页中执行无参数 JavaScript 函数并返回结果。用于根据上下文动态精确获取页面数据、操作 DOM。"
    )]
    async fn execute_script(
        &self,
        Parameters(params): Parameters<ExecuteScriptParams>,
    ) -> Result<CallToolResult, McpError> {
        let resp = self.request_extension(&serde_json::json!({"type": "execute_script", "tabId": params.tab_id, "funcStr": params.func_str})).await?;
        if let Some(r) = Self::check_error(&resp) {
            return Ok(r);
        }
        Self::json_result(&resp)
    }

    #[tool(
        description = "在浏览器扩展背景环境中执行无参数 JavaScript 函数并返回结果。用于根据上下文操控浏览器窗口和标签。所有扩展 API 都可以使用，请用 chrome 命名空间使用 async/await 函数"
    )]
    async fn execute_script_in_background(
        &self,
        Parameters(params): Parameters<ExecuteScriptInBackgroundParams>,
    ) -> Result<CallToolResult, McpError> {
        let resp = self.request_extension(&serde_json::json!({"type": "execute_script_in_background", "funcStr": params.func_str})).await?;
        if let Some(r) = Self::check_error(&resp) {
            return Ok(r);
        }
        Self::json_result(&resp)
    }

    #[tool(
        description = "获取指定标签页的 localStorage 数据（长内容被截断）。用于读取页面本地存储的状态信息。"
    )]
    async fn get_local_storage(
        &self,
        Parameters(params): Parameters<GetLocalStorageParams>,
    ) -> Result<CallToolResult, McpError> {
        let resp = self
            .request_extension(
                &serde_json::json!({"type": "get_local_storage", "tabId": params.tab_id}),
            )
            .await?;
        if let Some(r) = Self::check_error(&resp) {
            return Ok(r);
        }
        Self::json_result(&resp)
    }
}

impl BrowserDataServer {
    /// Send a request to the browser extension and wait for response (30s timeout).
    async fn request_extension(
        &self,
        msg: &serde_json::Value,
    ) -> Result<serde_json::Value, McpError> {
        let rx = self.messenger.request(msg).await;
        match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(resp)) => Ok(resp),
            Ok(Err(_)) => Err(McpError::new(
                ErrorCode(-32603),
                "Browser extension disconnected",
                None,
            )),
            Err(_) => Err(McpError::new(
                ErrorCode(-32603),
                "Timeout waiting for browser extension",
                None,
            )),
        }
    }

    fn check_error(resp: &serde_json::Value) -> Option<CallToolResult> {
        if resp.get("type").and_then(|t| t.as_str()) == Some("error") {
            let err = resp
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("unknown");
            Some(CallToolResult::success(vec![Content::text(format!(
                "Error: {}",
                err
            ))]))
        } else {
            None
        }
    }

    fn json_result(value: &serde_json::Value) -> Result<CallToolResult, McpError> {
        let json = serde_json::to_string_pretty(value).unwrap_or_else(|e| format!("Error: {}", e));
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }
}

#[tool_handler]
impl ServerHandler for BrowserDataServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
        .with_server_info(Implementation::from_build_env())
        .with_instructions(
            "你可以直接读取用户浏览器中已打开的标签页内容、在标签页中执行指定函数。典型场景：用户需要获取某个网页的内容，但该网页是本地服务、内网系统（如内部管理后台、RDC 等）或需要登录的个人数据页面，无法通过普通 HTTP 请求访问，此时用户浏览器中通常已经打开了该页面。如果用户直接要求获取当前页面数据（tabId, url，title，content），直接调用 read_active_tab；如果需要从多个标签中选择，先调用 list_tabs 列出所有标签，再根据上下文选择匹配的标签调用 read_tab。".to_string(),
        )
    }
}
