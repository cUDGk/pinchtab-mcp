#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isIP } from "node:net";
import { z } from "zod";

// ---------------------------------------------------------------------------
// S1: URL validation at startup
// ---------------------------------------------------------------------------
// Reject loopback/private ranges and non-canonical IPv4 forms (hex/octal/
// decimal-int) that would otherwise bypass naive string equality checks.
function isPrivateOrLoopback(hostname: string): boolean {
  const h = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (h === "localhost") return true;
  // IPv6 loopback / IPv4-mapped loopback / link-local / ULA
  const lower = h.toLowerCase();
  if (lower === "::1") return true;
  if (/^::ffff:/.test(lower)) return true;
  // S1: IPv4-mapped IPv6 fully-expanded form (e.g. 0:0:0:0:0:ffff:127.0.0.1)
  const v6mapped = lower.replace(/^(0+:){5}(0*:)?ffff:/, "::ffff:");
  if (v6mapped.startsWith("::ffff:")) {
    const embedded = v6mapped.slice(7);
    // Dotted IPv4 form (::ffff:127.0.0.1)
    if (/^\d+\.\d+\.\d+\.\d+$/.test(embedded)) {
      if (isPrivateOrLoopback(embedded)) return true;
    }
    // Hex-pair form (::ffff:7f00:0001)
    const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(embedded);
    if (m) {
      const hi = parseInt(m[1]!, 16);
      const lo = parseInt(m[2]!, 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      if (isPrivateOrLoopback(v4)) return true;
    }
  }
  if (lower.startsWith("fe80:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // S2: NAT64 prefix — block 64:ff9b:: and 64:ff9b:1::
  if (lower.startsWith("64:ff9b:")) return true;
  // Reject non-canonical IPv4 forms (hex 0x..., octal 0..., decimal-int)
  if (/^0x[\da-f]+$/i.test(h)) return true;
  if (/^0\d/.test(h)) return true;
  if (/^\d{8,10}$/.test(h)) return true;
  // S6: Mixed-radix dotted IPv4 — block non-canonical dotted forms that
  // contain only digit/hex/dot chars but don't parse as a valid IPv4 address.
  if (h.includes(".") && /^[\dxa-fA-F.]+$/.test(h) && isIP(h) !== 4) {
    return true;
  }
  // Standard IPv4 private check
  if (isIP(h) === 4) {
    const parts = h.split(".").map(Number);
    const a = parts[0]!;
    const b = parts[1]!;
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

const ALLOW_REMOTE = process.env.PINCHTAB_ALLOW_REMOTE === "1";
const ALLOW_EVALUATE = process.env.PINCHTAB_ALLOW_EVALUATE === "1";

function validatePinchtabUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`PINCHTAB_URL is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `PINCHTAB_URL protocol must be http or https, got: ${parsed.protocol}`
    );
  }
  if (!ALLOW_REMOTE && !isPrivateOrLoopback(parsed.hostname)) {
    throw new Error(
      `PINCHTAB_URL hostname "${parsed.hostname}" is not loopback. ` +
        `Set PINCHTAB_ALLOW_REMOTE=1 to allow remote hosts.`
    );
  }
  return raw.replace(/\/+$/, "");
}

const PINCHTAB_URL = validatePinchtabUrl(
  process.env.PINCHTAB_URL ?? "http://localhost:9867"
);
const PINCHTAB_TOKEN = process.env.PINCHTAB_TOKEN ?? "";

// S5: warn if token is sent over plain HTTP
if (PINCHTAB_TOKEN && PINCHTAB_URL.startsWith("http:")) {
  process.stderr.write(
    "[pinchtab-mcp] WARNING: PINCHTAB_TOKEN sent over plain HTTP. Use https://...\n"
  );
}

// NaN guard for timeout
const _rawTimeout = Number(process.env.PINCHTAB_TIMEOUT ?? "30000");
const PINCHTAB_TIMEOUT =
  Number.isFinite(_rawTimeout) && _rawTimeout > 0
    ? Math.min(_rawTimeout, 120_000)
    : 30_000;

// ---------------------------------------------------------------------------
// S3: URL validation helper for user-supplied URLs
// ---------------------------------------------------------------------------
const METADATA_HOSTS = ["169.254.169.254", "metadata.google.internal", "metadata"];

function assertHttpUrl(url: string, paramName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${paramName} is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `${paramName} must use http or https, got: ${parsed.protocol}`
    );
  }
  // S3: always block cloud-metadata endpoints, even when ALLOW_REMOTE=1.
  if (METADATA_HOSTS.includes(parsed.hostname.toLowerCase())) {
    throw new Error(`${paramName} targets cloud metadata endpoint`);
  }
  // when ALLOW_REMOTE=0, also reject private/loopback URLs to prevent
  // SSRF from the AI navigating the headless browser to internal services.
  if (!ALLOW_REMOTE && isPrivateOrLoopback(parsed.hostname)) {
    throw new Error(
      `${paramName} hostname "${parsed.hostname}" is private/loopback. ` +
        `Set PINCHTAB_ALLOW_REMOTE=1 to allow.`
    );
  }
}

// ---------------------------------------------------------------------------
// S5: Body size caps
// ---------------------------------------------------------------------------
const MAX_TEXT_BODY = 4 * 1024 * 1024; // 4 MiB
const MAX_BINARY_BODY = 32 * 1024 * 1024; // 32 MiB

async function pinchtabFetch(
  path: string,
  opts: { method?: string; body?: unknown; rawResponse?: boolean } = {}
): Promise<any> {
  // S4: prevent URL manipulation — path must be a server-relative absolute
  // path. A scheme-relative ("//host") or absolute URL would smuggle the
  // request to an attacker-controlled host once joined with PINCHTAB_URL.
  if (!path.startsWith("/") || path.startsWith("//")) {
    return { error: `Internal: pinchtabFetch path must start with single '/': ${path}` };
  }
  const url = `${PINCHTAB_URL}${path}`;
  const headers: Record<string, string> = {};
  if (PINCHTAB_TOKEN) headers["Authorization"] = `Bearer ${PINCHTAB_TOKEN}`;
  if (opts.body) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PINCHTAB_TIMEOUT);

  try {
    const res = await fetch(url, {
      method: opts.method || (opts.body ? "POST" : "GET"),
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    if (opts.rawResponse) return res;

    // S5: Check Content-Length before reading
    const contentLengthHeader = res.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const cl = parseInt(contentLengthHeader, 10);
      if (!isNaN(cl) && cl > MAX_TEXT_BODY) {
        return { error: `Response too large: ${cl} bytes (max ${MAX_TEXT_BODY})` };
      }
    }

    const text = await res.text();

    // S5: Hard-cap after read
    if (text.length > MAX_TEXT_BODY) {
      return { error: `Response too large: ${text.length} bytes (max ${MAX_TEXT_BODY})` };
    }

    if (!res.ok) return { error: `${res.status} ${res.statusText}`, body: text };
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { error: `Request timed out after ${PINCHTAB_TIMEOUT}ms: ${path}` };
    }
    return {
      error: `Connection failed: ${err?.message}. Is PinchTab running at ${PINCHTAB_URL}?`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// B5: actions that need an element ref
// ---------------------------------------------------------------------------
const ELEMENT_REQUIRES_REF = new Set([
  "click",
  "hover",
  "focus",
  "type",
  "press",
  "fill",
  "select",
]);

function textContent(data: unknown) {
  const text =
    typeof data === "string"
      ? data
      : (data as any)?.text ?? JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

const server = new McpServer({
  name: "pinchtab",
  version: "1.0.0",
});

server.tool(
  "pinchtab",
  `Browser control via PinchTab. Actions:
- navigate: go to URL (url, tabId?, newTab?, blockImages?, timeout?)
- snapshot: accessibility tree (filter?, format?, selector?, maxTokens?, depth?, diff?, tabId?)
- click/type/press/fill/hover/scroll/select/focus: act on element (ref, text?, key?, value?, scrollY?, waitNav?, tabId?)
- text: extract readable text (mode?, tabId?)
- tabs: list/new/close tabs (tabAction?, url?, tabId?)
- screenshot: JPEG screenshot (quality?, tabId?)
- evaluate: run JS (expression, tabId?)
- pdf: export page as PDF (landscape?, scale?, tabId?)
- health: check connectivity

Token strategy: use "text" for reading (~800 tokens), "snapshot" with filter=interactive&format=compact for interactions (~3,600 tokens), diff=true on subsequent snapshots.`,
  {
    action: z
      .enum([
        "navigate",
        "snapshot",
        "click",
        "type",
        "press",
        "fill",
        "hover",
        "scroll",
        "select",
        "focus",
        "text",
        "tabs",
        "screenshot",
        "evaluate",
        "pdf",
        "health",
      ])
      .describe("Action to perform"),
    url: z.string().optional().describe("URL for navigate or new tab"),
    ref: z.string().optional().describe("Element ref from snapshot (e.g. e5)"),
    text: z.string().optional().describe("Text to type or fill"),
    key: z.string().optional().describe("Key to press (e.g. Enter, Tab, Escape)"),
    expression: z.string().optional().describe("JavaScript expression to evaluate (requires PINCHTAB_ALLOW_EVALUATE=1)"),
    selector: z
      .string()
      .optional()
      .describe("CSS selector for snapshot scope or action target"),
    filter: z
      .enum(["interactive", "all"])
      .optional()
      .describe("Snapshot filter: interactive = buttons/links/inputs only"),
    format: z
      .enum(["json", "compact", "text", "yaml"])
      .optional()
      .describe("Snapshot format: compact is most token-efficient"),
    maxTokens: z.number().optional().describe("Truncate snapshot to ~N tokens"),
    depth: z.number().optional().describe("Max snapshot tree depth"),
    diff: z
      .boolean()
      .optional()
      .describe("Snapshot diff: only changes since last snapshot"),
    value: z.string().optional().describe("Value for select dropdown"),
    scrollY: z.number().optional().describe("Pixels to scroll vertically"),
    waitNav: z.boolean().optional().describe("Wait for navigation after action"),
    tabId: z.string().optional().describe("Target tab ID"),
    tabAction: z
      .enum(["list", "new", "close"])
      .optional()
      .describe("Tab sub-action (default: list)"),
    newTab: z.boolean().optional().describe("Open URL in new tab"),
    blockImages: z.boolean().optional().describe("Block image loading"),
    timeout: z.number().optional().describe("Navigation timeout in seconds"),
    quality: z.number().optional().describe("JPEG quality 1-100 (default: 80)"),
    mode: z
      .enum(["readability", "raw"])
      .optional()
      .describe("Text extraction mode"),
    landscape: z.boolean().optional().describe("PDF landscape orientation"),
    scale: z.number().optional().describe("PDF print scale (default: 1.0)"),
  },
  async (params) => {
    const { action } = params;

    // navigate
    if (action === "navigate") {
      if (params.url === undefined) return textContent({ error: "navigate requires url" });
      try {
        assertHttpUrl(params.url, "url");
      } catch (e) {
        return textContent({ error: e instanceof Error ? e.message : String(e) });
      }
      const body: any = { url: params.url };
      if (params.tabId) body.tabId = params.tabId;
      if (params.newTab) body.newTab = true;
      if (params.blockImages) body.blockImages = true;
      if (params.timeout) body.timeout = params.timeout;
      return textContent(await pinchtabFetch("/navigate", { body }));
    }

    // snapshot
    if (action === "snapshot") {
      const query = new URLSearchParams();
      if (params.tabId) query.set("tabId", params.tabId);
      if (params.filter) query.set("filter", params.filter);
      if (params.format) query.set("format", params.format);
      if (params.selector) query.set("selector", params.selector);
      if (params.maxTokens) query.set("maxTokens", String(params.maxTokens));
      if (params.depth) query.set("depth", String(params.depth));
      if (params.diff) query.set("diff", "true");
      const qs = query.toString();
      return textContent(
        await pinchtabFetch(`/snapshot${qs ? `?${qs}` : ""}`)
      );
    }

    // element actions
    const elementActions = [
      "click",
      "type",
      "press",
      "fill",
      "hover",
      "scroll",
      "select",
      "focus",
    ];
    if (elementActions.includes(action)) {
      // S: required guards using ELEMENT_REQUIRES_REF
      if (ELEMENT_REQUIRES_REF.has(action) && params.ref === undefined) {
        return textContent({ error: `${action} requires ref` });
      }
      if (action === "scroll" && params.scrollY === undefined) {
        return textContent({ error: "scroll requires scrollY" });
      }
      const body: any = { kind: action };
      for (const k of [
        "ref",
        "text",
        "key",
        "selector",
        "value",
        "scrollY",
        "tabId",
        "waitNav",
      ]) {
        if ((params as any)[k] !== undefined) body[k] = (params as any)[k];
      }
      return textContent(await pinchtabFetch("/action", { body }));
    }

    // text
    if (action === "text") {
      const query = new URLSearchParams();
      if (params.tabId) query.set("tabId", params.tabId);
      if (params.mode) query.set("mode", params.mode);
      const qs = query.toString();
      return textContent(
        await pinchtabFetch(`/text${qs ? `?${qs}` : ""}`)
      );
    }

    // tabs
    if (action === "tabs") {
      const tabAction = params.tabAction || "list";
      if (tabAction === "list") {
        return textContent(await pinchtabFetch("/tabs"));
      }
      // S3: validate URL for new tab
      if (tabAction === "new") {
        if (params.url === undefined) return textContent({ error: "tabs new requires url" });
        try {
          assertHttpUrl(params.url, "url");
        } catch (e) {
          return textContent({ error: e instanceof Error ? e.message : String(e) });
        }
      }
      const body: any = { action: tabAction };
      if (params.url) body.url = params.url;
      if (params.tabId) body.tabId = params.tabId;
      return textContent(await pinchtabFetch("/tab", { body }));
    }

    // screenshot
    if (action === "screenshot") {
      const query = new URLSearchParams();
      if (params.tabId) query.set("tabId", params.tabId);
      if (params.quality) query.set("quality", String(params.quality));
      const qs = query.toString();
      try {
        const res = await pinchtabFetch(
          `/screenshot${qs ? `?${qs}` : ""}`,
          { rawResponse: true }
        );
        if (res instanceof Response) {
          if (!res.ok) {
            return textContent({
              error: `Screenshot failed: ${res.status} ${await res.text()}`,
            });
          }
          // S5: screenshot size cap
          const clHeader = res.headers.get("content-length");
          if (clHeader !== null) {
            const cl = parseInt(clHeader, 10);
            if (!isNaN(cl) && cl > MAX_BINARY_BODY) {
              await res.body?.cancel().catch(() => {});
              return textContent({ error: `Screenshot too large: ${cl} bytes (max ${MAX_BINARY_BODY})` });
            }
          }
          const buf = await res.arrayBuffer();
          if (buf.byteLength > MAX_BINARY_BODY) {
            return textContent({ error: `Screenshot too large: ${buf.byteLength} bytes (max ${MAX_BINARY_BODY})` });
          }
          const b64 = Buffer.from(buf).toString("base64");
          return {
            content: [
              { type: "image" as const, data: b64, mimeType: "image/jpeg" },
            ],
          };
        }
        return textContent(res);
      } catch (err: any) {
        return textContent({ error: `Screenshot failed: ${err?.message}` });
      }
    }

    // evaluate
    if (action === "evaluate") {
      if (params.expression === undefined) {
        return textContent({ error: "evaluate requires expression" });
      }
      // S4: guardrails
      if (!ALLOW_EVALUATE) {
        return textContent({ error: "evaluate is disabled. Set PINCHTAB_ALLOW_EVALUATE=1 to enable." });
      }
      if (params.expression.length > 10_240) {
        return textContent({ error: `evaluate expression too long: ${params.expression.length} chars (max 10240)` });
      }
      const body: any = { expression: params.expression };
      if (params.tabId) body.tabId = params.tabId;
      return textContent(await pinchtabFetch("/evaluate", { body }));
    }

    // pdf
    if (action === "pdf") {
      const query = new URLSearchParams();
      if (params.tabId) query.set("tabId", params.tabId);
      if (params.landscape) query.set("landscape", "true");
      if (params.scale) query.set("scale", String(params.scale));
      const qs = query.toString();

      const res = await pinchtabFetch(`/pdf${qs ? `?${qs}` : ""}`, { rawResponse: true });
      if (!(res instanceof Response)) {
        return textContent(res);
      }
      if (!res.ok) {
        const errText = await res.text();
        return textContent({ error: `PDF export failed: ${res.status} ${errText}` });
      }
      // S5: PDF size cap
      const clHeader = res.headers.get("content-length");
      if (clHeader !== null) {
        const cl = parseInt(clHeader, 10);
        if (!isNaN(cl) && cl > MAX_BINARY_BODY) {
          await res.body?.cancel().catch(() => {});
          return textContent({ error: `PDF too large: ${cl} bytes (max ${MAX_BINARY_BODY})` });
        }
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BINARY_BODY) {
        return textContent({ error: `PDF too large: ${buf.byteLength} bytes (max ${MAX_BINARY_BODY})` });
      }
      const b64 = Buffer.from(buf).toString("base64");
      return {
        content: [
          {
            type: "resource" as const,
            resource: {
              uri: "data:application/pdf;base64," + b64,
              mimeType: "application/pdf",
              blob: b64,
            },
          },
        ],
      };
    }

    // health
    if (action === "health") {
      return textContent(await pinchtabFetch("/health"));
    }

    return textContent({ error: `Unknown action: ${action}` });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
