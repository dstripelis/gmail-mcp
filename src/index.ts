#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createStatefulServer } from "@smithery/sdk/server/stateful.js"
import { z } from "zod"
import { google, gmail_v1, calendar_v3 } from 'googleapis'
import fs from "fs"
import { createOAuth2Client, launchAuthServer, validateCredentials } from "./oauth2.js"
import { MCP_CONFIG_DIR, PORT, TELEMETRY_ENABLED } from "./config.js"
import { instrumentServer } from "@shinzolabs/instrumentation-mcp"

type Draft = gmail_v1.Schema$Draft
type DraftCreateParams = gmail_v1.Params$Resource$Users$Drafts$Create
type DraftUpdateParams = gmail_v1.Params$Resource$Users$Drafts$Update
type Message = gmail_v1.Schema$Message
type MessagePart = gmail_v1.Schema$MessagePart
type MessagePartBody = gmail_v1.Schema$MessagePartBody
type MessagePartHeader = gmail_v1.Schema$MessagePartHeader
type MessageSendParams = gmail_v1.Params$Resource$Users$Messages$Send
type Thread = gmail_v1.Schema$Thread

type NewMessage = {
  threadId?: string
  raw?: string
  to?: string[] | undefined
  cc?: string[] | undefined
  bcc?: string[] | undefined
  subject?: string | undefined
  body?: string | undefined
  includeBodyHtml?: boolean
}

const RESPONSE_HEADERS_LIST = [
  'Date',
  'From',
  'To',
  'Subject',
  'Message-ID',
  'In-Reply-To',
  'References'
]

const defaultOAuth2Client = createOAuth2Client()

const defaultGmailClient = defaultOAuth2Client ? google.gmail({ version: 'v1', auth: defaultOAuth2Client }) : null

const defaultCalendarClient = defaultOAuth2Client ? google.calendar({ version: 'v3', auth: defaultOAuth2Client }) : null

const formatResponse = (response: any) => ({ content: [{ type: "text", text: JSON.stringify(response) }] })

const gmailToolHandler = async (queryConfig: Record<string, any> | undefined, apiCall: (gmail: gmail_v1.Gmail) => Promise<any>) => {
  try {
    const oauth2Client = queryConfig ? createOAuth2Client(queryConfig) : defaultOAuth2Client
    if (!oauth2Client) throw new Error('OAuth2 client could not be created, please check your credentials')

    const credentialsAreValid = await validateCredentials(oauth2Client)
    if (!credentialsAreValid) throw new Error('OAuth2 credentials are invalid, please re-authenticate')

    const gmailClient = queryConfig ? google.gmail({ version: 'v1', auth: oauth2Client }) : defaultGmailClient
    if (!gmailClient) throw new Error('Gmail client could not be created, please check your credentials')

    const result = await apiCall(gmailClient)
    return result
  } catch (error: any) {
    // Check for specific authentication errors
    if (
      error.message?.includes("invalid_grant") ||
      error.message?.includes("refresh_token") ||
      error.message?.includes("invalid_client") ||
      error.message?.includes("unauthorized_client") ||
      error.code === 401 ||
      error.code === 403
    ) {
      return formatResponse({
        error: `Authentication failed: ${error.message}. Please re-authenticate by running: npx @shinzolabs/gmail-mcp auth`,
      });
    }

    return formatResponse({ error: `Tool execution failed: ${error.message}` });
  }
}

const calendarToolHandler = async (queryConfig: Record<string, any> | undefined, apiCall: (calendar: calendar_v3.Calendar) => Promise<any>) => {
  try {
    const oauth2Client = queryConfig ? createOAuth2Client(queryConfig) : defaultOAuth2Client
    if (!oauth2Client) throw new Error('OAuth2 client could not be created, please check your credentials')

    const credentialsAreValid = await validateCredentials(oauth2Client)
    if (!credentialsAreValid) throw new Error('OAuth2 credentials are invalid, please re-authenticate')

    const calendarClient = queryConfig ? google.calendar({ version: 'v3', auth: oauth2Client }) : defaultCalendarClient
    if (!calendarClient) throw new Error('Calendar client could not be created, please check your credentials')

    const result = await apiCall(calendarClient)
    return result
  } catch (error: any) {
    // Check for specific authentication errors
    if (
      error.message?.includes("invalid_grant") ||
      error.message?.includes("refresh_token") ||
      error.message?.includes("invalid_client") ||
      error.message?.includes("unauthorized_client") ||
      error.code === 401 ||
      error.code === 403
    ) {
      return formatResponse({
        error: `Authentication failed: ${error.message}. Please re-authenticate by running: npx @shinzolabs/gmail-mcp auth`,
      });
    }

    return formatResponse({ error: `Tool execution failed: ${error.message}` });
  }
}

const decodedBody = (body: MessagePartBody) => {
  if (!body?.data) return body

  const decodedData = Buffer.from(body.data, 'base64').toString('utf-8')
  const decodedBody: MessagePartBody = {
    data: decodedData,
    size: body.data.length,
    attachmentId: body.attachmentId
  }
  return decodedBody
}

const processMessagePart = (messagePart: MessagePart, includeBodyHtml = false): MessagePart => {
  if ((messagePart.mimeType !== 'text/html' || includeBodyHtml) && messagePart.body) {
    messagePart.body = decodedBody(messagePart.body)
  }

  if (messagePart.parts) {
    messagePart.parts = messagePart.parts.map(part => processMessagePart(part, includeBodyHtml))
  }

  if (messagePart.headers) {
    messagePart.headers = messagePart.headers.filter(header => RESPONSE_HEADERS_LIST.includes(header.name || ''))
  }

  return messagePart
}

const getNestedHistory = (messagePart: MessagePart, level = 1): string => {
  if (messagePart.mimeType === 'text/plain' && messagePart.body?.data) {
    const { data } = decodedBody(messagePart.body)
    if (!data) return ''
    return data.split('\n').map(line => '>' + (line.startsWith('>') ? '' : ' ') + line).join('\n')
  }

  return (messagePart.parts || []).map(p => getNestedHistory(p, level + 1)).filter(p => p).join('\n')
}

const findHeader = (headers: MessagePartHeader[] | undefined, name: string) => {
  if (!headers || !Array.isArray(headers) || !name) return undefined
  return headers.find(h => h?.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined
}

const getQuotedContent = (thread: Thread) => {
  if (!thread.messages?.length) return ''

  const sentMessages = thread.messages.filter(msg =>
    msg.labelIds?.includes('SENT') ||
    (!msg.labelIds?.includes('DRAFT') && findHeader(msg.payload?.headers || [], 'date'))
  )

  if (!sentMessages.length) return ''

  const lastMessage = sentMessages[sentMessages.length - 1]
  if (!lastMessage?.payload) return ''

  let quotedContent = []

  if (lastMessage.payload.headers) {
    const fromHeader = findHeader(lastMessage.payload.headers || [], 'from')
    const dateHeader = findHeader(lastMessage.payload.headers || [], 'date')
    if (fromHeader && dateHeader) {
      quotedContent.push('')
      quotedContent.push(`On ${dateHeader} ${fromHeader} wrote:`)
      quotedContent.push('')
    }
  }

  const nestedHistory = getNestedHistory(lastMessage.payload)
  if (nestedHistory) {
    quotedContent.push(nestedHistory)
    quotedContent.push('')
  }

  return quotedContent.join('\n')
}

const getThreadHeaders = (thread: Thread) => {
  let headers: string[] = []

  if (!thread.messages?.length) return headers

  const lastMessage = thread.messages[thread.messages.length - 1]
  const references: string[] = []

  let subjectHeader = findHeader(lastMessage.payload?.headers || [], 'subject')
  if (subjectHeader) {
    if (!subjectHeader.toLowerCase().startsWith('re:')) {
      subjectHeader = `Re: ${subjectHeader}`
    }
    headers.push(`Subject: ${subjectHeader}`)
  }

  const messageIdHeader = findHeader(lastMessage.payload?.headers || [], 'message-id')
  if (messageIdHeader) {
    headers.push(`In-Reply-To: ${messageIdHeader}`)
    references.push(messageIdHeader)
  }

  const referencesHeader = findHeader(lastMessage.payload?.headers || [], 'references')
  if (referencesHeader) references.unshift(...referencesHeader.split(' '))

  if (references.length > 0) headers.push(`References: ${references.join(' ')}`)

  return headers
}

const wrapTextBody = (text: string): string => text.split('\n').map(line => {
  if (line.length <= 76) return line
  const chunks = line.match(/.{1,76}/g) || []
  return chunks.join('=\n')
}).join('\n')

const constructRawMessage = async (gmail: gmail_v1.Gmail, params: NewMessage) => {
  let thread: Thread | null = null
  if (params.threadId) {
    const threadParams = { userId: 'me', id: params.threadId, format: 'full' }
    const { data } = await gmail.users.threads.get(threadParams)
    thread = data
  }

  const message = []

  if (params.to?.length) message.push(`To: ${wrapTextBody(params.to.join(', '))}`)
  if (params.bcc?.length) message.push(`Bcc: ${wrapTextBody(params.bcc.join(', '))}`)
  
  if (thread) {
    message.push(...getThreadHeaders(thread).map(header => wrapTextBody(header)))
  } else if (params.subject) {
    message.push(`Subject: ${wrapTextBody(params.subject)}`)
  } else {
    message.push('Subject: (No Subject)')
  }
  message.push('Content-Type: text/plain; charset="UTF-8"')
  message.push('Content-Transfer-Encoding: quoted-printable')
  message.push('MIME-Version: 1.0')
  message.push('')

  if (params.body) message.push(wrapTextBody(params.body))

  if (thread) {
    const quotedContent = getQuotedContent(thread)
    if (quotedContent) {
      message.push('')
      message.push(wrapTextBody(quotedContent))
    }
  }

  return Buffer.from(message.join('\r\n')).toString('base64url').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function getConfig(config: any) {
  return {
    telemetryEnabled: config?.TELEMETRY_ENABLED || TELEMETRY_ENABLED
  }
}

function createServer({ config }: { config?: Record<string, any> }) {
  const serverInfo = {
    name: "GoogleServices-MCP",
    version: "1.7.4",
    description: "GoogleServices MCP - Provides complete Google API access with file-based OAuth2 authentication"
  }

  const server = new McpServer(serverInfo)

  const { telemetryEnabled } = getConfig(config)

  if (telemetryEnabled !== "false") {
    const telemetry = instrumentServer(server, {
      serverName: serverInfo.name,
      serverVersion: serverInfo.version,
      exporterEndpoint: "https://api.otel.shinzo.tech/v1"
    })
  }

  server.tool("get_emails",
    "Get emails from the user's mailbox with optional filtering, retrieving full details for each message.",
    {      
      q: z.string().describe("Only return messages matching the specified query. Supports the same query format as the Gmail search box"),
      maxResults: z.number().describe("Maximum number of messages to return."),
    },
    async (params) => {
      return gmailToolHandler(config, async (gmail: gmail_v1.Gmail) => {
        // First, list messages to get their IDs
        const { data: listData } = await gmail.users.messages.list({ userId: 'me', ...params });

        if (!listData.messages || listData.messages.length === 0) {
          return formatResponse(listData); // Return empty list response
        }

        // Now, fetch the full details for each message
        const fullMessages = await Promise.all(
          listData.messages.map(async (message) => {
            if (!message.id) return null;
            const { data } = await gmail.users.messages.get({
              userId: 'me',
              id: message.id,
              format: 'full',
            });

            // Process the payload of the full message
            if (data.payload) {
              data.payload = processMessagePart(data.payload);
            }
            return data;
          })
        );

        // Replace the summary messages with the full message details
        listData.messages = fullMessages.filter((m): m is Message => m !== null);

        return formatResponse(listData);
      });
    }
  );

  server.tool("send_email",
    "Send an email to a specific recipient.",
    {    
      to: z.array(z.string()).describe("The email address(es) to send the email to"),
      bcc: z.array(z.string()).optional().describe("The list of email addresses to send a copy (BCC) of the email"),
      subject: z.string().describe("The subject of the email"),
      body: z.string().describe("The body of the email"),
    },
    async (params) => {
      return gmailToolHandler(config, async (gmail: gmail_v1.Gmail) => {

        let raw = params.raw
        if (!raw) raw = await constructRawMessage(gmail, params)

        const messageSendParams: MessageSendParams = { userId: 'me', requestBody: { raw } }
        const { data } = await gmail.users.messages.send(messageSendParams)
        if (data.payload) {
          data.payload = processMessagePart(
            data.payload,
            params.includeBodyHtml
          )
        }

        return formatResponse(data)
      })
    }
  );

//   server.tool("get_email_threads",
//     "List threads in the user's mailbox",
//     {      
//       q: z.string().describe("Only return threads matching the specified query"),
//       maxResults: z.number().describe("Maximum number of threads to return"),
//     },
//     async (params) => {
//       return handleTool(config, async (gmail: gmail_v1.Gmail) => {
//         // First, list threads to get their IDs
//         const listResponse = await gmail.users.threads.list({
//           userId: 'me',
//           q: params.q,
//           maxResults: params.maxResults,
//           pageToken: params.pageToken,
//         });

//         const threadsData = listResponse.data;
//         if (!threadsData.threads || threadsData.threads.length === 0) {
//           return formatResponse(threadsData); // Return empty list response
//         }

//         // Now, fetch the full details for each thread
//         const fullThreads = await Promise.all(
//           threadsData.threads.map(async (thread) => {
//             if (!thread.id) return null;
//             const { data: fullThread } = await gmail.users.threads.get({
//               userId: 'me',
//               id: thread.id,
//               format: 'full',
//             });

//             // Process messages within the full thread
//             if (fullThread.messages) {
//               fullThread.messages = fullThread.messages.map(message => {
//                 if (message.payload) {
//                   message.payload = processMessagePart(message.payload);
//                 }
//                 return message;
//               });
//             }
//             return fullThread;
//           })
//         );

//         // Replace the summary threads with the full thread details
//         threadsData.threads = fullThreads.filter((t): t is Thread => t !== null);

//         return formatResponse(threadsData);
//       });
//     }
//   );


  server.tool("get_calendar_events",
    "Get events and meetings from the Google Calendar of the user.",
    {
        timeMin: z.string().optional().describe("Lower bound for event start time (RFC3339, default: now)"),
        timeMax: z.string().optional().describe("Upper bound for event start time (RFC3339)"),      
        q: z.string().optional().describe("Free-text search query"),
    },
        async (params) => {
        return calendarToolHandler(config, async (calendar: calendar_v3.Calendar) => {
            try {
                const auth = defaultOAuth2Client || createOAuth2Client()
                if (!auth) throw new Error("OAuth2 client is not initialized")
                const calendar = google.calendar({ version: "v3", auth })
                const nowIso = new Date().toISOString()
                const { data } = await calendar.events.list({
                    calendarId: "primary",
                    timeMin: params.timeMin || nowIso,
                    timeMax: params.timeMax,
                    q: params.q,
                })
                return formatResponse(data)
            } catch (error: any) {
                return formatResponse({ error: error?.message || String(error) })
            }
        }
  )});

  return server.server

}

const main = async () => {
  fs.mkdirSync(MCP_CONFIG_DIR, { recursive: true })

  if (process.argv[2] === 'auth') {
    if (!defaultOAuth2Client) throw new Error('OAuth2 client could not be created, please check your credentials')
    await launchAuthServer(defaultOAuth2Client)
    process.exit(0)
  }

  // Stdio Server
  const stdioServer = createServer({})
  const transport = new StdioServerTransport()
  await stdioServer.connect(transport)

  // Streamable HTTP Server
  const { app } = createStatefulServer(createServer)
  app.listen(PORT)
}

main()
