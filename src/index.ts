#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isIP } from "node:net";
import { z } from "zod";

// ---------------------------------------------------------------------------
// S1: URL validation at startup
// ---------------------------------------------------------------------------
function isPrivateOrLoopback(hostname: string): boolean {
  const h = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (h === "localhost") return true;
  const lower = h.toLowerCase();
  if (lower === "::1") return true;
  if (/^::ffff:/.test(lower)) return true;
  const v6mapped = lower.replace(/^(0+:){5}(0*:)?ffff:/, "::ffff:");
  if (v6mapped.startsWith("::ffff:")) {
    const embedded = v6mapped.slice(7);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(embedded)) {
      if (isPrivateOrLoopback(embedded)) return true;
    }
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
  if (lower.startsWith("64:ff9b:")) return true;
  if (/^0x[\da-f]+$/i.test(h)) return true;
  if (/^0\d/.test(h)) return true;
  if (/^\d{8,10}$/.test(h)) return true;
  if (h.includes(".") && /^[\dxa-fA-F.]+$/.test(h) && isIP(h) !== 4) {
    return true;
  }
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

const MAX_TEXT_BODY = 4 * 1024 * 1024;
const MAX_BINARY_BODY = 32 * 1024 * 1024;

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

async function pinchtabFetch(
  path: string,
  opts: { method?: string; body?: unknown; rawResponse?: boolean } = {}
): Promise<FetchResult> {
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

async function pinchtabFetchRaw(
  path: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<FetchRaw | FetchError> {
  const result = await pinchtabFetch(path, { ...opts, rawResponse: true });
  if (!result.ok) return result;
  if ("raw" in result) return result;
  return { ok: false, error: "Unexpected non-raw response" };
}

function textContent(data: unknown) {
  const text =
    typeof data === "string"
      ? data
      : (data as any)?.text ?? JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function errorContent(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

function fetchResultToContent(result: FetchResult) {
  if (!result.ok) return errorContent(result.error);
  if ("raw" in result) {
    // B4: cancel dangling body and surface as real error
    result.res.body?.cancel().catch(() => {});
    return errorContent("Internal: raw response reached fetchResultToContent");
  }
  return textContent(result.data);
}

const ELEMENT_REQUIRES_REF = new Set([
  "click",
  "hover",
  "focus",
  "type",
  "press",
  "fill",
  "select",
]);

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
    value: z.string().optional().describe("Value for fill/select actions"),
    scrollY: z.number().optional().describe("Pixels to scroll vertically"),
    waitNav: z.boolean().optional().describe("Wait for navigation after action"),
    tabId: z.string().optional().describe("Target tab ID"),
    tabAction: z
      .enum(["list", "new", "close"])
      .optional()
      .describe("Tab sub-action (default: list)"),
    newTab: z.boolean().optional().describe("Open URL in new tab"),
    blockImages: z.boolean().optional().describe("Block image loading"),
    timeout: z.number().optional().describe("Navigation timeout in ms"),
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
      if (params.url === undefined) return errorContent("navigate requires url");
      try {
        assertHttpUrl(params.url, "url");
      } catch (e) {
        return errorContent(e instanceof Error ? e.message : String(e));
      }
      const body: NavigateBody = { url: params.url };
      if (params.tabId !== undefined) body.tabId = params.tabId;
      if (params.newTab !== undefined) body.newTab = params.newTab;
      if (params.blockImages !== undefined) body.blockImages = params.blockImages;
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
      if (params.maxTokens !== undefined)
        query.set("maxTokens", String(params.maxTokens));
      if (params.depth !== undefined) query.set("depth", String(params.depth));
      // B2: pass through both true and false
      if (params.diff !== undefined) query.set("diff", String(params.diff));
      const qs = query.toString();
      return fetchResultToContent(
        await pinchtabFetch(`/snapshot${qs ? `?${qs}` : ""}`, {})
      );
    }

    // element actions
    if (
      action === "click" ||
      action === "type" ||
      action === "press" ||
      action === "fill" ||
      action === "hover" ||
      action === "scroll" ||
      action === "select" ||
      action === "focus"
    ) {
      if (action === "scroll" && params.scrollY === undefined) {
        return errorContent("scroll requires scrollY");
      }
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
      if (tabAction === "new" && params.url === undefined) {
        return errorContent("tabs new requires url");
      }
      if (tabAction === "close" && params.tabId === undefined) {
        return errorContent("tabs close requires tabId");
      }
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

      const result = await pinchtabFetchRaw(`/screenshot${qs ? `?${qs}` : ""}`);
      if (!result.ok) return errorContent(result.error);

      const res = result.res;
      if (res.bodyUsed) {
        return errorContent("Screenshot response body was already consumed");
      }
      if (!res.ok) {
        const errText = await res.text();
        return errorContent(`Screenshot failed: ${res.status} ${errText}`);
      }

      const clHeader = res.headers.get("content-length");
      if (clHeader !== null) {
        const cl = parseInt(clHeader, 10);
        if (!isNaN(cl) && cl > MAX_BINARY_BODY) {
          await res.body?.cancel().catch(() => {});
          return errorContent(`Screenshot too large: ${cl} bytes (max ${MAX_BINARY_BODY})`);
        }
      }

      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BINARY_BODY) {
        return errorContent(`Screenshot too large: ${buf.byteLength} bytes (max ${MAX_BINARY_BODY})`);
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
      if (params.expression === undefined) {
        return errorContent("evaluate requires expression");
      }
      if (!ALLOW_EVALUATE) {
        return errorContent("evaluate is disabled. Set PINCHTAB_ALLOW_EVALUATE=1 to enable.");
      }
      if (params.expression.length > 10_240) {
        return errorContent(`evaluate expression too long: ${params.expression.length} chars (max 10240)`);
      }
      const body: EvaluateBody = { expression: params.expression };
      if (params.tabId !== undefined) body.tabId = params.tabId;
      return fetchResultToContent(await pinchtabFetch("/evaluate", { body }));
    }

    // pdf
    if (action === "pdf") {
      const query = new URLSearchParams();
      if (params.tabId !== undefined) query.set("tabId", params.tabId);
      // B1: previously sent "true" regardless of value
      if (params.landscape !== undefined)
        query.set("landscape", String(params.landscape));
      if (params.scale !== undefined) query.set("scale", String(params.scale));
      const qs = query.toString();

      const result = await pinchtabFetchRaw(`/pdf${qs ? `?${qs}` : ""}`);
      if (!result.ok) return errorContent(result.error);

      const res = result.res;
      // B1: guard bodyUsed before any read
      if (res.bodyUsed) {
        return errorContent("PDF response body was already consumed");
      }
      if (!res.ok) {
        const errText = await res.text();
        return errorContent(`PDF export failed: ${res.status} ${errText}`);
      }

      const clHeader = res.headers.get("content-length");
      if (clHeader !== null) {
        const cl = parseInt(clHeader, 10);
        if (!isNaN(cl) && cl > MAX_BINARY_BODY) {
          await res.body?.cancel().catch(() => {});
          return errorContent(`PDF too large: ${cl} bytes (max ${MAX_BINARY_BODY})`);
        }
      }

      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BINARY_BODY) {
        return errorContent(`PDF too large: ${buf.byteLength} bytes (max ${MAX_BINARY_BODY})`);
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

    // exhaustiveness check
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
