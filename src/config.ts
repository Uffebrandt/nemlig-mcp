/** Process-wide configuration, read once from the environment at startup. */

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export interface NemligCredentials {
  username: string;
  password: string;
}

/** Shortest MCP_PATH_SECRET accepted; the path is the only thing guarding the endpoint. */
export const MIN_PATH_SECRET_LENGTH = 32;

export class InvalidPathSecretError extends Error {
  constructor(length: number) {
    super(
      length === 0
        ? 'MCP_PATH_SECRET is not set. It guards the public endpoint at /mcp/<secret>; ' +
            `set it to a random string of at least ${MIN_PATH_SECRET_LENGTH} characters ` +
            '(e.g. `openssl rand -hex 32`).'
        : `MCP_PATH_SECRET is too short (${length} characters); it must be at least ` +
            `${MIN_PATH_SECRET_LENGTH}. Generate one with \`openssl rand -hex 32\`.`,
    );
    this.name = 'InvalidPathSecretError';
  }
}

/** Returns the secret, or throws when it is missing or too short to be worth guessing. */
export function requirePathSecret(value: string | undefined): string {
  const secret = value ?? '';
  if (secret.length < MIN_PATH_SECRET_LENGTH) throw new InvalidPathSecretError(secret.length);
  return secret;
}

const envUsername = str('NEMLIG_USERNAME', '');
const envPassword = str('NEMLIG_PASSWORD', '');

export const config = {
  host: str('HOST', '0.0.0.0'),
  port: int('PORT', 8080),

  /**
   * The MCP endpoint is served at /mcp/<secret> only. Read raw here and validated
   * by requirePathSecret, so a missing one stops the server rather than opening it.
   */
  mcpPathSecret: process.env['MCP_PATH_SECRET'] ?? '',

  /** Everything that must outlive the container lands here. */
  dataDir: str('NEMLIG_DATA_DIR', 'data'),

  /**
   * The account used when a client does not send its own credentials. Optional:
   * a deployment can be header-only, in which case a client that sends nothing
   * gets a clear error rather than a silent fallback.
   */
  defaultCredentials:
    envUsername && envPassword ? ({ username: envUsername, password: envPassword } as NemligCredentials) : null,

  /** Let a client override the account per request via X-Nemlig-Username/-Password. */
  allowHeaderCredentials: bool('NEMLIG_ALLOW_HEADER_CREDENTIALS', true),

  login: {
    /** How long to keep re-minting the token after login while waiting for the debitorId to appear. */
    sessionTimeoutMs: int('NEMLIG_SESSION_READY_TIMEOUT_MS', 20_000),
    /** Cap on concurrent logins; login is cheap now, but this bounds a stampede. */
    maxConcurrent: int('NEMLIG_LOGIN_MAX_CONCURRENT', 4),
    /**
     * Re-authenticate this long before `exp`. Nemlig's tokens last five minutes and
     * an expired one does not fail — it silently answers as an anonymous visitor —
     * so the margin has to cover a slow call rather than just clock skew.
     */
    refreshMarginMs: int('NEMLIG_REFRESH_MARGIN_MS', 45_000),
  },

  /** A session is forgotten once untouched for this long; its next use logs in again. */
  sessionTtlMs: int('NEMLIG_SESSION_TTL_MS', 7 * 24 * 60 * 60 * 1000),

  nemlig: {
    webBaseUrl: str('NEMLIG_WEB_BASE_URL', 'https://www.nemlig.com'),
    searchBaseUrl: str('NEMLIG_SEARCH_BASE_URL', 'https://webapi.prod.knl.nemlig.it'),
    /** Nemlig's customer-aware backend-for-frontend, where favourites now come from. */
    bffBaseUrl: str('NEMLIG_BFF_BASE_URL', 'https://webapi.prod.knl.nemlig.it'),
    bffFavouritesPath: str('NEMLIG_BFF_FAVOURITES_PATH', '/favoritter'),
    searchPageSize: int('NEMLIG_SEARCH_PAGE_SIZE', 20),
    userAgent: str(
      'NEMLIG_USER_AGENT',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ),
  },
} as const;

export type Config = typeof config;
