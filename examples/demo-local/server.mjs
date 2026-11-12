#!/usr/bin/env node
/**
 * Minimal dependency-free MCP server living on D:.
 *
 * Speaks the stdio transport: one JSON-RPC 2.0 object per line. It exists to
 * prove that a server whose working directory and package cache sit on D: is
 * spawned and driven by `@deepseek-ai/dsh-mcp-client` exactly like any other.
 *
 * Tools: ping, where.
 */

import { createInterface } from 'node:readline'
import { cwd } from 'node:process'

const PROTOCOL = '2024-11-05'

const TOOLS = [
  {
    name: 'ping',
    description: 'Returns pong. Proves the server is alive.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'where',
    description: 'Returns the working directory this MCP server runs in.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(request) {
  const { id, method, params } = request
  const isNotification = id === undefined
  if (method === 'initialize') {
    reply({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'demo-local', version: '1.0.0' },
      },
    })
    return
  }
  if (isNotification) return
  if (method === 'ping') {
    reply({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    reply({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const name = params && params.name
    if (name !== 'ping' && name !== 'where') {
      reply({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } })
      return
    }
    const text = name === 'ping' ? 'pong' : cwd()
    reply({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
    return
  }
  reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } })
}

const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  const text = line.trim()
  if (!text) return
  let request
  try {
    request = JSON.parse(text)
  } catch {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    return
  }
  handle(request)
})
