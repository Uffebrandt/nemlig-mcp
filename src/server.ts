import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type onRequestHookHandler,
  type RouteHandlerMethod,
} from 'fastify';
import { config, requirePathSecret } from './config.js';
import { credentialsFrom, MissingCredentialsError } from './credentials.js';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from './mcp.js';
import type { SessionManager } from './sessions.js';

/** JSON-RPC error code for an unhandled server-side failure. */
const INTERNAL_ERROR = -32_603;

/** Stands in for the path secret wherever a URL is logged. */
const REDACTED = '[redacted]';

export interface HttpServerOptions {
  /** Defaults to MCP_PATH_SECRET; validated either way. */
  pathSecret?: string;
  /** Where the log goes; stdout by default. Tests pass a stream to inspect it. */
  logStream?: NodeJS.WritableStream;
}

export function createHttpServer(sessions: SessionManager, options: HttpServerOptions = {}): FastifyInstance {
  const secret = requirePathSecret(options.pathSecret ?? config.mcpPathSecret);
  const secretDigest = digest(secret);

  /** Constant time: both sides are hashed to the same length before comparing. */
  const isSecret = (candidate: string) => timingSafeEqual(digest(candidate), secretDigest);

  /** The secret is in the path, so no URL reaches the log without passing through here. */
  const redactUrl = (url: string) => {
    const path = url.startsWith('/mcp/') ? `/mcp/${REDACTED}` : url;
    return path.split(secret).join(REDACTED);
  };

  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      ...(options.logStream ? { stream: options.logStream } : {}),
      serializers: {
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: redactUrl(request.url),
          remoteAddress: request.ip,
        }),
      },
    },
  });

  // Fastify's own 404 names the route it did not find, both in the body and the
  // log; this one says nothing, so a wrong secret looks like any unknown path.
  const notFound = (reply: FastifyReply) => reply.code(404).send();
  app.setNotFoundHandler(async (_request, reply) => notFound(reply));

  // Open, for Fly's health check — so it says nothing about the account.
  app.get('/health', async () => ({ status: 'ok', server: SERVER_NAME, version: SERVER_VERSION }));

  /**
   * Checked before the body is parsed, so a wrong secret gets the same bare 404
   * whatever it sends — never a 400 or 415 that would show the route exists.
   */
  const requireSecret: onRequestHookHandler = async (request, reply) => {
    const candidate = (request.params as { '*'?: string })['*'] ?? '';
    if (!isSecret(candidate)) return notFound(reply);
  };

  /**
   * Stateless streamable HTTP: a transport and MCP server per request. The state
   * worth keeping — the Nemlig login — lives in the session manager and on disk,
   * so a client reconnecting, or the container restarting, costs nothing.
   */
  app.post('/mcp/*', { onRequest: requireSecret }, async (request, reply) => {
    let credentials;
    try {
      credentials = credentialsFrom(request.headers);
    } catch (error) {
      if (!(error instanceof MissingCredentialsError)) throw error;
      await reply.code(401).send(rpcError(error.message));
      return;
    }

    const mcpServer = createMcpServer(sessions, credentials);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    reply.raw.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });

    try {
      await mcpServer.connect(transport);
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error }, 'MCP request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify(rpcError('Internal server error')));
      }
    }
  });

  // Stateless mode has no stream to resume and no session to delete.
  const methodNotAllowed: RouteHandlerMethod = async (_request, reply) =>
    reply.code(405).send(rpcError('Method not allowed. This server is stateless; send requests as HTTP POST.'));
  app.get('/mcp/*', { onRequest: requireSecret }, methodNotAllowed);
  app.delete('/mcp/*', { onRequest: requireSecret }, methodNotAllowed);

  return app;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function rpcError(message: string) {
  return { jsonrpc: '2.0', error: { code: INTERNAL_ERROR, message }, id: null };
}
