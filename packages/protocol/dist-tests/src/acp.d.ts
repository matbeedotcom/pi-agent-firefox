/**
 * ACP (Agent Client Protocol) surface used by Pi Browser.
 *
 * Canonical types and method constants come from the official
 * @agentclientprotocol/sdk package; this module re-exports the subset that
 * both the Pi native host and the Firefox add-on consume.
 */
export { AGENT_METHODS, CLIENT_METHODS, PROTOCOL_METHODS, PROTOCOL_VERSION, } from "@agentclientprotocol/sdk";
export type { InitializeRequest, InitializeResponse, AgentCapabilities, ClientCapabilities, PromptCapabilities, McpCapabilities, SessionCapabilities, Implementation, ProtocolVersion, NewSessionRequest, NewSessionResponse, LoadSessionRequest, LoadSessionResponse, ListSessionsRequest, ListSessionsResponse, ResumeSessionRequest, ResumeSessionResponse, CloseSessionRequest, CloseSessionResponse, SessionInfo, PromptRequest, PromptResponse, CancelNotification, StopReason, ContentBlock, TextContent, ImageContent as AcpImageContent, AudioContent, ResourceLink, EmbeddedResource, Usage, SessionNotification, SessionUpdate, ContentChunk, ToolCall, ToolCallUpdate, ToolCallContent, ToolCallStatus, ToolKind, ConfigOptionUpdate, SessionModeState, SessionMode, SessionConfigOption, SessionConfigSelect, SessionConfigBoolean, SessionConfigOptionCategory, SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, McpServer, McpServerStdio, McpServerHttp, McpServerSse, McpServerAcp, McpServerAcpId, McpConnectionId, ConnectMcpRequest, ConnectMcpResponse, DisconnectMcpRequest, MessageMcpRequest, MessageMcpResponse, } from "@agentclientprotocol/sdk";
//# sourceMappingURL=acp.d.ts.map