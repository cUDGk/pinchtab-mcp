#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isIP } from "node:net";
import { createRequire } from "node:module";
import { z } from "zod";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

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
    if (m && m[1] !== undefined && m[2] !== undefined) {
      const hi = parseInt(m[1], 16);
      const lo = parseInt(m[2], 16);
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
    const [a, b] = parts;
    if (a === undefined || b === undefined) return false;
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

if (PINCHTAB_TOKEN && PINCHTAB_URL.startsWith("http:")) {
  process.stderr.write(
    "[pinchtab-mcp] WARNING: PINCHTAB_TOKEN sent over plain HTTP. Use https://...\n"
  );
}

const _rawTimeout = Number(process.env.PINCHTAB_TIMEOUT ?? "30000");
const PINCHTAB_TIMEOUT =
  Number.isFinite(_rawTimeout) && _rawTimeout > 0
    ? Math.min(_rawTimeout, 120_000)
    : 30_000;

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
  if (METADATA_HOSTS.includes(parsed.hostname.toLowerCase())) {
    throw new Error(`${paramName} targets cloud metadata endpoint`);
  }
  if (!ALLOW_REMOTE && isPrivateOrLoopback(parsed.hostname)) {
    throw new Error(
      `${paramName} hostname "${parsed.hostname}" is private/loopback. ` +
        `Set PINCHTAB_ALLOW_REMOTE=1 to allow.`
    );
  }
}

const MAX_TEXT_BODY = 4 * 1024 * 1024; // 4 MiB
const MAX_BINARY_BODY = 32 * 1024 * 1024; // 32 MiB

// ---------------------------------------------------------------------------
// B1: Discriminated union return type for pinchtabFetch
// ---------------------------------------------------------------------------
type FetchSuccess = { ok: true; data: unknown };
type FetchRaw = { ok: true; raw: true; res: Response };
type FetchError = { ok: false; error: string };
type FetchResult = FetchSuccess | FetchRaw | FetchError;

// ---------------------------------------------------------------------------
// B4: Explicit body interfaces
// ---------------------------------------------------------------------------
interface NavigateBody {
  url: string;
  tabId?: string;
  newTab?: boolean;
  blockImages?: boolean;
  timeout?: number;
}

interface ActionBody {
  kind: string;
  ref?: string;
  text?: string;
  key?: string;
  selector?: string;
  value?: string;
  scrollY?: number;
  tabId?: string;
  waitNav?: boolean;
}

interface TabBody {
  action: string;
  url?: string;
  tabId?: string;
}

interface EvaluateBody {
  expression: string;
  tabId?: string;
}

// ---------------------------------------------------------------------------
// Core fetch helper
// ---------------------------------------------------------------------------
async function pinchtabFetch(
  path: string,
  opts: { method?: string; body?: unknown; rawResponse?: boolean } = {}
): Promise<FetchResult> {
  // S4: prevent URL manipulation — path must be a server-relative absolute
  // path. A scheme-relative ("//host") or absolute URL would smuggle the
  // request to an attacker-controlled host once joined with PINCHTAB_URL.
  if (!path.startsWith("/") || path.startsWith("//")) {
    return {
      ok: false,
      error: `Internal: pinchtabFetch path must start with single '/': ${path}`,
    };
  }
  const url = `${PINCHTAB_URL}${path}`;
  const headers: Record<string, string> = {};
  if (PINCHTAB_TOKEN) headers["Authorization"] = `Bearer ${PINCHTAB_TOKEN}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PINCHTAB_TIMEOUT);

  try {
    // exactOptionalPropertyTypes: body must be null (not undefined) when absent
    const res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
      signal: controller.signal,
    });

    // B2: rawResponse — return raw; caller is responsible for body read
    if (opts.rawResponse === true) {
      clearTimeout(timer);
      return { ok: true, raw: true, res };
    }

    // S5: Check Content-Length before reading
    const contentLengthHeader = res.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const cl = parseInt(contentLengthHeader, 10);
      if (!isNaN(cl) && cl > MAX_TEXT_BODY) {
        return {
          ok: false,
          error: `Response too large: ${cl} bytes (max ${MAX_TEXT_BODY})`,
        };
      }
    }

    const text = await res.text();

    // S5: Hard-cap after read
    if (text.length > MAX_TEXT_BODY) {
      return {
        ok: false,
        error: `Response too large: ${text.length} bytes (max ${MAX_TEXT_BODY})`,
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        error: `${res.status} ${res.statusText}: ${text}`,
      };
    }

    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: true, data: { text } };
    }
  } catch (err: unknown) {
    // B3: err: unknown + instanceof narrowing
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        error: `Request timed out after ${PINCHTAB_TIMEOUT}ms: ${path}`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Connection failed: ${msg}. Is PinchTab running at ${PINCHTAB_URL}?`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Raw-response variant that returns only FetchRaw | FetchError
async function pinchtabFetchRaw(
  path: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<FetchRaw | FetchError> {
  const result = await pinchtabFetch(path, { ...opts, rawResponse: true });
  if (!result.ok) return result;
  if ("raw" in result) return result;
  // Should never happen with rawResponse: true but satisfy TS
  return { ok: false, error: "Unexpected non-raw response" };
}

// ---------------------------------------------------------------------------
// Helper: build MCP text content
// ---------------------------------------------------------------------------
function textContent(data: unknown) {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else if (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    "text" in data
  ) {
    // U13: narrow before cast — was dereferencing arrays/null via the cast.
    text = String((data as { text: unknown }).text);
  } else {
    text = JSON.stringify(data, null, 2);
  }
  return { content: [{ type: "text" as const, text }] };
}

// U1: isError helper for all error paths
function errorContent(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

function fetchResultToContent(result: FetchResult) {
  if (!result.ok) return errorContent(result.error);
  if ("raw" in result) {
    // B4: a raw response should never reach this helper — callers asking for
    // a raw body must use pinchtabFetchRaw directly. Surface as a real error
    // (and cancel the dangling body) instead of returning a misleading
    // "[raw response]" success string.
    result.res.body?.cancel().catch(() => {});
    return errorContent(
      "Internal: raw response reached fetchResultToContent"
    );
  }
  return textContent(result.data);
}

// ---------------------------------------------------------------------------
// B5: actions that need an element ref. Centralised so the validation list
// can't drift from the action enum.
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

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
// U9: pull version from package.json so it doesn't drift from the npm tag.
const server = new McpServer({
  name: "pinchtab",
  version: pkg.version,
});

// U2: Tool name changed to "browser" → mcp__pinchtab__browser
server.tool(
  "browser",
  // U6: Per-action grouped description
  `Browser control via PinchTab. Single tool with \`action\` dispatch.

**Navigation**
- \`navigate\` — go to URL  | required: \`url\` | optional: \`tabId\`, \`newTab\`, \`blockImages\`, \`timeout\`
- \`back\`     — history back
- \`forward\`  — history forward

**Reading**
- \`snapshot\` — accessibility tree  | optional: \`filter\`, \`format\`, \`selector\`, \`maxTokens\`, \`depth\`, \`diff\`, \`tabId\`
- \`text\`     — readable text        | optional: \`mode\`, \`tabId\`

**Element actions**
- \`click\`   — click element         | required: \`ref\`
- \`type\`    — append/type text      | required: \`ref\`, \`text\`
- \`fill\`    — clear+set value       | required: \`ref\`, \`value\`
- \`press\`   — key press             | required: \`ref\`, \`key\`
- \`hover\`   — hover element         | required: \`ref\`
- \`scroll\`  — scroll page/element   | required: \`scrollY\` | optional: \`ref\`
- \`select\`  — pick dropdown option  | required: \`ref\`, \`value\`
- \`focus\`   — focus element         | required: \`ref\`

**Tabs**
- \`tabs\`    — tab management        | required: \`tabAction\` | \`list\` (no extras), \`new\` requires \`url\`, \`close\` requires \`tabId\`

**Media / scripting**
- \`screenshot\` — JPEG image         | optional: \`quality\` (1-100), \`tabId\`
- \`evaluate\`   — run JS (requires PINCHTAB_ALLOW_EVALUATE=1) | required: \`expression\` | optional: \`tabId\`
- \`pdf\`        — export PDF as base64 resource | optional: \`landscape\`, \`scale\`, \`tabId\`

**Utility**
- \`health\` — check PinchTab connectivity

Token guide: \`text\` ~800 tok | \`snapshot filter=interactive format=compact\` ~3,600 tok | \`screenshot\` ~2,000 image tokens (not text tokens)`,
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
        // U12: history navigation — wired through the same /action endpoint
        // as click/hover so PinchTab dispatches by `kind`.
        "back",
        "forward",
      ])
      .describe("Action to perform"),
    url: z.string().optional().describe("URL for navigate or new tab"),
    ref: z.string().optional().describe("Element ref from snapshot (e.g. e5)"),
    // U5: type uses text (append/type), fill uses value (clear+set)
    text: z
      .string()
      .optional()
      .describe("Text to append/type (for type action)"),
    value: z
      .string()
      .optional()
      .describe("Value to set (for fill/select actions)"),
    key: z.string().optional().describe("DOM KeyboardEvent.key value (case-sensitive: 'Enter', 'Tab', 'Escape')"),
    expression: z
      .string()
      .optional()
      .describe(
        "JavaScript expression to evaluate (requires PINCHTAB_ALLOW_EVALUATE=1)"
      ),
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
    // U2: positive integers only (was unbounded — `0` and floats slipped through).
    maxTokens: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Truncate snapshot to ~N tokens"),
    depth: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Max snapshot tree depth"),
    diff: z
      .boolean()
      .optional()
      .describe("Snapshot diff: only changes since last snapshot"),
    scrollY: z.number().finite().optional().describe("Pixels to scroll vertically"),
    waitNav: z.boolean().optional().describe("Wait for navigation after action"),
    tabId: z.string().optional().describe("Target tab ID"),
    // U4: spell out per-sub-action requirements so the agent doesn't guess.
    tabAction: z
      .enum(["list", "new", "close"])
      .optional()
      .describe(
        "Tab sub-action (default: list). `new` requires `url`; `close` requires `tabId`."
      ),
    newTab: z.boolean().optional().describe("Open URL in new tab"),
    blockImages: z.boolean().optional().describe("Block image loading"),
    // U3: must be positive — unit follows PinchTab API; verify before
    // relying on the default.
    timeout: z
      .number()
      .positive()
      .optional()
      .describe("Navigation timeout in ms (default: 30000)"),
    // U4: schema constraints for quality
    quality: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("JPEG quality 1-100 (default: 80)"),
    mode: z
      .enum(["readability", "raw"])
      .optional()
      .describe("Text extraction mode"),
    landscape: z.boolean().optional().describe("PDF landscape orientation"),
    // U1: PinchTab/Chrome PDF print scale is bounded.
    scale: z
      .number()
      .min(0.1)
      .max(2.0)
      .optional()
      .describe("PDF print scale 0.1-2.0 (default: 1.0)"),
  },
  async (params) => {
    const { action } = params;

    // navigate
    if (action === "navigate") {
      // U3: required guard
      if (params.url === undefined) return errorContent("navigate requires url");
      // S3: validate user URL
      try {
        assertHttpUrl(params.url, "url");
      } catch (e) {
        return errorContent(e instanceof Error ? e.message : String(e));
      }
      const body: NavigateBody = { url: params.url };
      if (params.tabId !== undefined) body.tabId = params.tabId;
      if (params.newTab !== undefined) body.newTab = params.newTab;
      if (params.blockImages !== undefined) body.blockImages = params.blockImages;
      // B6: !== undefined instead of falsy
      if (params.timeout !== undefined) body.timeout = params.timeout;
      return fetchResultToContent(await pinchtabFetch("/navigate", { body }));
    }

    // snapshot
    if (action === "snapshot") {
      const query = new URLSearchParams();
      if (params.tabId !== undefined) query.set("tabId", params.tabId);
      if (params.filter !== undefined) query.set("filter", params.filter);
      if (params.format !== undefined) query.set("format", params.format);
      if (params.selector !== undefined) query.set("selector", params.selector);
      // B6: !== undefined for numeric params (zero is valid)
      if (params.maxTokens !== undefined)
        query.set("maxTokens", String(params.maxTokens));
      if (params.depth !== undefined) query.set("depth", String(params.depth));
      // B2: pass through both true and false; previously `diff: false` was
      // silently dropped, so callers couldn't disable a server-side default.
      if (params.diff !== undefined) query.set("diff", String(params.diff));
      const qs = query.toString();
      return fetchResultToContent(
        await pinchtabFetch(`/snapshot${qs ? `?${qs}` : ""}`, {})
      );
    }

    // element actions — B10: no cast, typed body builder
    if (
      action === "click" ||
      action === "type" ||
      action === "press" ||
      action === "fill" ||
      action === "hover" ||
      action === "scroll" ||
      action === "select" ||
      action === "focus" ||
      action === "back" ||
      action === "forward"
    ) {
      // U3: required guards per action
      if (action === "scroll" && params.scrollY === undefined) {
        return errorContent("scroll requires scrollY");
      }
      // B5: single source of truth for ref-required actions.
      if (ELEMENT_REQUIRES_REF.has(action) && params.ref === undefined) {
        return errorContent(`${action} requires ref`);
      }
      if (action === "type" && params.text === undefined) {
        return errorContent("type requires text");
      }
      if (action === "fill" && params.value === undefined) {
        return errorContent("fill requires value");
      }
      if (action === "press" && params.key === undefined) {
        return errorContent("press requires key");
      }
      if (action === "select" && params.value === undefined) {
        return errorContent("select requires value");
      }
      const body: ActionBody = { kind: action };
      if (params.ref !== undefined) body.ref = params.ref;
      if (params.key !== undefined) body.key = params.key;
      if (params.selector !== undefined) body.selector = params.selector;
      if (params.scrollY !== undefined) body.scrollY = params.scrollY;
      if (params.tabId !== undefined) body.tabId = params.tabId;
      if (params.waitNav !== undefined) body.waitNav = params.waitNav;
      // U5: type uses text, fill uses value; others accept both
      if (action === "type") {
        if (params.text !== undefined) body.text = params.text;
      } else if (action === "fill") {
        if (params.value !== undefined) body.value = params.value;
      } else {
        if (params.text !== undefined) body.text = params.text;
        if (params.value !== undefined) body.value = params.value;
      }
      return fetchResultToContent(await pinchtabFetch("/action", { body }));
    }

    // text
    if (action === "text") {
      const query = new URLSearchParams();
      if (params.tabId !== undefined) query.set("tabId", params.tabId);
      if (params.mode !== undefined) query.set("mode", params.mode);
      const qs = query.toString();
      return fetchResultToContent(
        await pinchtabFetch(`/text${qs ? `?${qs}` : ""}`, {})
      );
    }

    // tabs
    if (action === "tabs") {
      const tabAction = params.tabAction ?? "list";
      if (tabAction === "list") {
        return fetchResultToContent(await pinchtabFetch("/tabs", {}));
      }
      // U3: required guards
      if (tabAction === "new" && params.url === undefined) {
        return errorContent("tabs new requires url");
      }
      if (tabAction === "close" && params.tabId === undefined) {
        return errorContent("tabs close requires tabId");
      }
      // S3: validate URL for new tab (params.url is defined; guard above returned if not)
      if (tabAction === "new") {
        try {
          assertHttpUrl(params.url!, "url");
        } catch (e) {
          return errorContent(e instanceof Error ? e.message : String(e));
        }
      }
      const body: TabBody = { action: tabAction };
      if (params.url !== undefined) body.url = params.url;
      if (params.tabId !== undefined) body.tabId = params.tabId;
      return fetchResultToContent(await pinchtabFetch("/tab", { body }));
    }

    // screenshot
    if (action === "screenshot") {
      const query = new URLSearchParams();
      if (params.tabId !== undefined) query.set("tabId", params.tabId);
      if (params.quality !== undefined)
        query.set("quality", String(params.quality));
      const qs = query.toString();

      // B7: pinchtabFetch never throws; no dead catch block
      const result = await pinchtabFetchRaw(
        `/screenshot${qs ? `?${qs}` : ""}`
      );
      if (!result.ok) return errorContent(result.error);

      const res = result.res;
      // B8: guard res.bodyUsed before reading
      if (res.bodyUsed) {
        return errorContent("Screenshot response body was already consumed");
      }
      if (!res.ok) {
        const errText = await res.text();
        return errorContent(`Screenshot failed: ${res.status} ${errText}`);
      }

      // S5 / S3: reject if over binary size cap. Cancel body to release the
      // socket back to the agent (B3) — otherwise the connection leaks.
      const clHeader = res.headers.get("content-length");
      if (clHeader !== null) {
        const cl = parseInt(clHeader, 10);
        if (!isNaN(cl) && cl > MAX_BINARY_BODY) {
          await res.body?.cancel().catch(() => {});
          return errorContent(
            `Screenshot too large: ${cl} bytes (max ${MAX_BINARY_BODY})`
          );
        }
      }

      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BINARY_BODY) {
        return errorContent(
          `Screenshot too large: ${buf.byteLength} bytes (max ${MAX_BINARY_BODY})`
        );
      }

      const b64 = Buffer.from(buf).toString("base64");
      return {
        content: [
          { type: "image" as const, data: b64, mimeType: "image/jpeg" },
        ],
      };
    }

    // evaluate
    if (action === "evaluate") {
      // U3: required guard
      if (params.expression === undefined) {
        return errorContent("evaluate requires expression");
      }
      // S4: guardrails
      if (!ALLOW_EVALUATE) {
        return errorContent(
          "evaluate is disabled. Set PINCHTAB_ALLOW_EVALUATE=1 to enable."
        );
      }
      if (params.expression.length > 10_240) {
        return errorContent(
          `evaluate expression too long: ${params.expression.length} chars (max 10240)`
        );
      }
      // B9: expression is defined here (guarded above)
      const body: EvaluateBody = { expression: params.expression };
      if (params.tabId !== undefined) body.tabId = params.tabId;
      return fetchResultToContent(await pinchtabFetch("/evaluate", { body }));
    }

    // pdf — B11: return as base64 MCP resource with mimeType pdf
    if (action === "pdf") {
      const query = new URLSearchParams();
      if (params.tabId !== undefined) query.set("tabId", params.tabId);
      // B1: previously sent "true" regardless of value, so `landscape: false`
      // accidentally enabled landscape mode.
      if (params.landscape !== undefined)
        query.set("landscape", String(params.landscape));
      if (params.scale !== undefined) query.set("scale", String(params.scale));
      const qs = query.toString();

      const result = await pinchtabFetchRaw(`/pdf${qs ? `?${qs}` : ""}`);
      if (!result.ok) return errorContent(result.error);

      const res = result.res;
      // B1: guard bodyUsed before any read (mirrors screenshot branch)
      if (res.bodyUsed) {
        return errorContent("PDF response body was already consumed");
      }
      if (!res.ok) {
        const errText = await res.text();
        return errorContent(`PDF export failed: ${res.status} ${errText}`);
      }

      // pre-read Content-Length so we don't buffer a huge PDF before
      // rejecting. Cancel body (B3) to release the socket on early return.
      const clHeader = res.headers.get("content-length");
      if (clHeader !== null) {
        const cl = parseInt(clHeader, 10);
        if (!isNaN(cl) && cl > MAX_BINARY_BODY) {
          await res.body?.cancel().catch(() => {});
          return errorContent(
            `PDF too large: ${cl} bytes (max ${MAX_BINARY_BODY})`
          );
        }
      }

      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BINARY_BODY) {
        return errorContent(
          `PDF too large: ${buf.byteLength} bytes (max ${MAX_BINARY_BODY})`
        );
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
      return fetchResultToContent(await pinchtabFetch("/health", {}));
    }

    // B12: compile-time exhaustiveness check
    const _exhaustive: never = action;
    return errorContent(`Unknown action: ${String(_exhaustive)}`);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
