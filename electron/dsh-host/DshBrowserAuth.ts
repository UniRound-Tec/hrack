import { request } from 'node:http'

/**
 * DSH 0.1.2+ browser-session gate: each process prints
 * `dsh web: http://127.0.0.1:<port>/?token=...`. GET `/` with that token mints
 * an authority-bound `dsh-auth-*` cookie; every RPC and event stream needs it.
 * Older hosts have no token line and accept unauthenticated loopback RPC.
 */

const LAUNCH_TOKEN_PATTERN = /dsh web:\s+\S*[?&]token=([A-Za-z0-9_-]+)/gi
const SESSION_COOKIE_PAIR =
  /^(dsh-auth-[A-Za-z0-9_-]+)=(v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/
const TOKEN_LENGTH_MIN = 16
const TOKEN_LENGTH_MAX = 128
const EXCHANGE_TIMEOUT_MS = 2_000

export function parseDshLaunchToken(output: string): string | null {
  let token: string | null = null
  for (const match of output.matchAll(LAUNCH_TOKEN_PATTERN)) {
    const value = match[1]
    if (
      value &&
      value.length >= TOKEN_LENGTH_MIN &&
      value.length <= TOKEN_LENGTH_MAX
    ) {
      token = value
    }
  }
  return token
}

export function parseDshSessionCookie(
  setCookie: string | string[] | undefined
): string | null {
  const lines = setCookie === undefined
    ? []
    : Array.isArray(setCookie)
      ? setCookie
      : [setCookie]
  for (const line of lines) {
    const pair = line.split(';', 1)[0]?.trim()
    if (!pair) continue
    const matched = SESSION_COOKIE_PAIR.exec(pair)
    if (matched) return `${matched[1]}=${matched[2]}`
  }
  return null
}

export function dshAuthenticatedPageUrl(
  baseUrl: string,
  token?: string | null
): string {
  const url = new URL(baseUrl)
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  if (token) url.searchParams.set('token', token)
  return url.href
}

export function redactDshLaunchToken(text: string): string {
  return text.replace(/([?&]token=)[A-Za-z0-9_-]+/gi, '$1[redacted]')
}

export function withDshSessionCookie(
  headers: Record<string, string>,
  cookie?: string | null
): Record<string, string> {
  if (!cookie) return headers
  return { ...headers, cookie }
}

/** Exchange the process launch token for a Host-bound session cookie. */
export function exchangeDshLaunchToken(
  baseUrl: string,
  token: string,
  authority?: string
): Promise<string> {
  const target = new URL(baseUrl)
  const host = authority ?? target.host
  const path = `/?token=${encodeURIComponent(token)}`
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: target.hostname,
      port: target.port,
      method: 'GET',
      path,
      headers: { host }
    }, (response) => {
      response.resume()
      const finish = (): void => {
        if (response.statusCode !== 303) {
          reject(
            new Error(`dsh token exchange HTTP ${response.statusCode ?? 0}`)
          )
          return
        }
        const cookie = parseDshSessionCookie(response.headers['set-cookie'])
        if (!cookie) {
          reject(new Error('dsh token exchange returned no session cookie'))
          return
        }
        resolve(cookie)
      }
      response.once('error', (error) => {
        reject(error instanceof Error ? error : new Error(String(error)))
      })
      if (response.complete) finish()
      else response.once('end', finish)
    })
    req.once('error', reject)
    req.setTimeout(EXCHANGE_TIMEOUT_MS, () => {
      req.destroy(new Error('dsh token exchange timed out'))
    })
    req.end()
  })
}
