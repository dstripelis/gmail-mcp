import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {type CallToolRequest} from "@modelcontextprotocol/sdk/types.js";

// expects to have the MCP Server up and running!
const streamableClientUrl = new URL("http://localhost:3000/mcp");

// Define RPC messages
const jsonRpcMessage = {
  sendEmail: {
    name: "send_email",
    arguments: {
      to: ["dimitris@flower.ai"],
      bcc: ["dimstripelis@gmail.com", "daniel.nata@flower.ai"],
      subject: "Test Subject",
      body: "Test Body"
    }
  },
};

async function main() {
  const client = new Client({
    name: "gmail-mcp-client",
    version: "0.0.1"
  });

  const transport = new StreamableHTTPClientTransport(streamableClientUrl);
  await client.connect(transport);
  console.log("✅  Connected to MCP server at", streamableClientUrl.href);

  // Ping
  const pingResponse = await client.ping();
  console.log("✅  Ping response:", pingResponse);

  // send a test message
  const sendEmailParams = jsonRpcMessage.sendEmail as CallToolRequest["params"];  
  const sendEmailResponse = await client.callTool(sendEmailParams);
  console.log("✅  Send email content:", sendEmailParams);
}

main().catch(err => {
  console.error("❌ Error running MCP client:", err);
  process.exit(1);
});