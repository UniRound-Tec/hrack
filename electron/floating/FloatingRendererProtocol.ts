import { protocol, type Session } from "electron";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { TERMINAL_BACKGROUND_SCHEME } from "../../shared/terminal-background";
import type { FloatingRendererRegistry } from "./FloatingRendererRegistry";

export const FLOATING_RENDERER_SCHEME = "hrack-floating";
const MAX_ASSET_BYTES = 16 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".moc3": "application/octet-stream",
  ".bytes": "application/octet-stream",
  ".frag": "text/plain; charset=utf-8",
  ".vert": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function response(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": CONTENT_SECURITY_POLICY,
      "x-content-type-options": "nosniff",
    },
  });
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Must run before app.ready. */
export function registerFloatingRendererScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FLOATING_RENDERER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
      },
    },
    {
      scheme: TERMINAL_BACKGROUND_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/**
 * Serves only files whose real path remains inside a validated user renderer.
 * The protocol is installed on the floating window's isolated session.
 */
export function installFloatingRendererProtocol(
  targetSession: Session,
  registry: FloatingRendererRegistry,
): () => void {
  targetSession.protocol.handle(FLOATING_RENDERER_SCHEME, async (request) => {
    if (request.method !== "GET") return response(405, "Method not allowed");
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return response(400, "Invalid URL");
    }
    const definition = registry.find(`user/${url.hostname}`);
    if (!definition || definition.source !== "user") {
      return response(404, "Renderer not found");
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return response(400, "Invalid path encoding");
    }
    if (pathname.includes("\0")) return response(400, "Invalid path");
    const requested = pathname === "/" ? definition.entry : pathname.slice(1);
    if (!requested || isAbsolute(requested))
      return response(400, "Invalid path");
    const candidate = resolve(definition.root, requested);
    if (!isInside(definition.root, candidate)) {
      return response(403, "Path escapes renderer root");
    }
    try {
      const realCandidate = await realpath(candidate);
      if (!isInside(definition.root, realCandidate)) {
        return response(403, "Path escapes renderer root");
      }
      const metadata = await stat(realCandidate);
      if (!metadata.isFile()) return response(404, "Asset not found");
      if (metadata.size > MAX_ASSET_BYTES)
        return response(413, "Asset too large");
      const data = await readFile(realCandidate);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          "content-type":
            CONTENT_TYPES[extname(realCandidate).toLowerCase()] ??
            "application/octet-stream",
          "content-security-policy": CONTENT_SECURITY_POLICY,
          "cross-origin-opener-policy": "same-origin",
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return response(404, "Asset not found");
    }
  });
  return () => {
    try {
      targetSession.protocol.unhandle(FLOATING_RENDERER_SCHEME);
    } catch {
      // Already unregistered or session is shutting down.
    }
  };
}
