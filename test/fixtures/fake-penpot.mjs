// Fake Penpot MCP server used by the Docker-only integration test.
// Kept dependency-free except for @modelcontextprotocol/sdk, which the test
// skips on when the host does not have the DSH profile mounted.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

export async function startFakePenpot(port = 0) {
  const mcp = new McpServer({ name: 'fake-penpot', version: '0.0.1' })

  mcp.registerTool(
    'high_level_overview',
    { description: 'Return the Penpot MCP orientation text.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: 'fake penpot overview' }] }),
  )
  mcp.registerTool(
    'execute_code',
    { description: 'Execute read-only plugin API code.', inputSchema: { code: z.string() } },
    async ({ code }) => ({ content: [{ type: 'text', text: `executed:${code}` }] }),
  )
  mcp.registerTool(
    'export_shape',
    { description: 'Export a shape.', inputSchema: { shapeId: z.string() } },
    async ({ shapeId }) => ({ content: [{ type: 'text', text: `exported:${shapeId}` }] }),
  )

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
  await mcp.connect(transport)

  const http = createServer(async (req, res) => {
    try {
      if (req.url !== '/mcp') {
        res.writeHead(404).end('not found')
        return
      }
      if (req.method === 'POST') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'))
        await transport.handleRequest(req, res, body)
        return
      }
      await transport.handleRequest(req, res)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error))
    }
  })

  await new Promise((resolve, reject) => {
    http.once('error', reject)
    http.listen(port, '127.0.0.1', resolve)
  })
  const { port: actualPort } = http.address()
  return {
    url: `http://127.0.0.1:${actualPort}/mcp`,
    close: async () => {
      http.closeAllConnections?.()
      await new Promise(resolve => http.close(resolve))
      await transport.close().catch(() => {})
      await mcp.close().catch(() => {})
    },
  }
}
