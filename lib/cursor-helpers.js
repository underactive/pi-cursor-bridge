/**
 * pi-cursor-agent — shared pure helpers.
 *
 * This module is intentionally DEPENDENCY-FREE: it imports nothing from
 * `@earendil-works/*` or `@cursor/sdk`, so it can be exercised in isolation via
 * `node --test` without Pi's peerDependencies installed.
 *
 * It lives OUTSIDE `./extensions/` on purpose. Pi auto-discovers every `.js`
 * under `./extensions` as its own extension (the same `jiti` auto-discovery trap
 * that orphaned the old standalone session module), so a sibling there would be
 * mis-loaded. `extensions/cursor-bridge.js` imports this via `../lib/cursor-helpers.js`,
 * which resolves through the file's realpath even when Pi loads the extension
 * through a symlink.
 */

const DATA_URI_PREFIX_RE = /^data:([^;,]+);base64,/i;

/**
 * Normalize a Pi `ImageContent` part into the SDK's `{ data, mimeType }` shape.
 *
 * Pi may deliver `data` as bare base64 OR as a full `data:<mime>;base64,…` URI.
 * The SDK expects bare base64, so strip the prefix when present and prefer the
 * mime type it encodes; otherwise pass the data through unchanged. (M4)
 *
 * @param {{data?: string, mimeType?: string}} part
 * @returns {{data: string, mimeType: string}}
 */
export function normalizeImageData(part) {
  const raw = part && typeof part.data === "string" ? part.data : "";
  const m = raw.match(DATA_URI_PREFIX_RE);
  if (m) {
    return { data: raw.slice(m[0].length), mimeType: (part && part.mimeType) || m[1] || "image/png" };
  }
  return { data: raw, mimeType: (part && part.mimeType) || "image/png" };
}

/**
 * Collect Pi `ImageContent` parts from user turns into SDK `SDKImage[]`.
 *
 * Returns `[]` when the target model is not vision-capable (the caller logs the
 * skip). Scans the whole history because the SDK backend uses a fresh agent per
 * turn, so earlier images must be re-sent for multi-turn image conversations.
 * User turns only — tool-produced images are a separate concern (backlog). (M4)
 *
 * @param {{messages?: Array}} context
 * @param {boolean} visionCapable — whether the routed model accepts images
 * @returns {Array<{data: string, mimeType: string}>}
 */
export function collectSdkImages(context, visionCapable) {
  if (!visionCapable) return [];
  const images = [];
  for (const msg of (context && context.messages) || []) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part && part.type === "image" && typeof part.data === "string" && part.data) {
        images.push(normalizeImageData(part));
      }
    }
  }
  return images;
}

/**
 * True only when an unhandled rejection's TOP stack frame originates inside
 * `node_modules/@cursor/sdk/`.
 *
 * The previous test (`stack.includes("@cursor/sdk")`) matched ANY error whose
 * stack or message merely mentioned the string, wrongly swallowing unrelated
 * rejections. This inspects only the first real stack frame. (M5)
 *
 * @param {unknown} reason
 * @returns {boolean}
 */
export function isSdkRejection(reason) {
  const stack = reason && typeof reason.stack === "string" ? reason.stack : "";
  if (!stack) return false;
  // Skip the message line(s); the first `at …` line is the top frame.
  const topFrame = stack
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("at "));
  if (!topFrame) return false;
  return topFrame.includes("node_modules/@cursor/sdk/");
}

/**
 * A resolvable/rejectable promise (for cross-turn tool bridging) with an
 * explicit settle-once guard: the first settle wins and flips `settled`; any
 * later resolve/reject is a no-op. Native Promises already ignore a second
 * settle, but the flag makes the contract explicit and refactor-safe. (L1)
 *
 * @returns {{promise: Promise, resolve: Function, reject: Function, settled: boolean}}
 */
export function makeSdkDeferred() {
  let resolveFn, rejectFn;
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  const deferred = {
    promise,
    settled: false,
    resolve(value) {
      if (deferred.settled) return;
      deferred.settled = true;
      resolveFn(value);
    },
    reject(err) {
      if (deferred.settled) return;
      deferred.settled = true;
      rejectFn(err);
    },
  };
  return deferred;
}

/**
 * Estimate the token count of one Pi conversation turn for the context gauge.
 *
 * Sums the forwarded prompt text plus this turn's assistant output blocks, then
 * divides by `charsPerToken` (chars/4 heuristic). Output blocks are counted
 * EXACTLY as Pi's own `estimateTokens()` counts an assistant message — text +
 * thinking + toolCall (name + JSON-serialized arguments) — so the value stays
 * stable when Pi later re-estimates this same message as a "trailing" message.
 *
 * This is the pure core of the SDK backend's `usage.totalTokens` override: it
 * sizes the gauge off Pi's own (compactable) conversation rather than Cursor's
 * opaque server-side agent context. Unknown/other block types contribute 0.
 *
 * @param {string} promptText — the forwarded conversation prompt (system/preamble + messages)
 * @param {Array<{type: string, text?: string, thinking?: string, name?: string, arguments?: object}>} outputBlocks — the assistant message content blocks
 * @param {number} [charsPerToken=4] — approximate chars per token
 * @returns {number} estimated tokens (>= 0)
 */
export function estimateConversationTokens(promptText, outputBlocks, charsPerToken = 4) {
  let chars = typeof promptText === "string" ? promptText.length : 0;
  for (const block of outputBlocks || []) {
    if (!block) continue;
    if (block.type === "text") chars += (block.text || "").length;
    else if (block.type === "thinking") chars += (block.thinking || "").length;
    else if (block.type === "toolCall") chars += (block.name || "").length + JSON.stringify(block.arguments || {}).length;
  }
  const per = charsPerToken > 0 ? charsPerToken : 4;
  return Math.max(0, Math.ceil(chars / per));
}

/**
 * Compute the Pi-facing usage fields for a finalized SDK assistant message.
 *
 * Pi reads usage for three things — the context-fill gauge + threshold compaction
 * (totalTokens), the footer stats (per-field counts), and SILENT context-overflow
 * detection (input + cacheRead > model.contextWindow). On the @cursor/sdk backend
 * Cursor's reported input/cacheRead describe ITS server-side agent context and a
 * cumulative, unbounded cacheRead — not the conversation Pi forwards and can
 * compact. Echoing them makes overflow detection fire on every successful turn
 * (input + cacheRead routinely dwarfs the window), which trips overflow-recovery
 * compaction and the "Cannot continue from message role: assistant" retry failure.
 *
 * So every field Pi compares to the window is sized off Pi's OWN forwarded
 * conversation: `input` = the forwarded-prompt estimate, `cacheRead`/`cacheWrite`
 * = 0, `totalTokens` = the prompt+output estimate. Only `output` is Cursor's real
 * model output — accurate, always small, and never part of the overflow compare.
 *
 * This is the pure core of the SDK backend's usage override. Keeping it here, with
 * cacheRead hard-zeroed, guards the invariant: Cursor's raw input/cacheRead must
 * never reach the fields Pi tests against the context window.
 *
 * @param {number} outputTokens — this turn's real (or estimated) model output tokens
 * @param {{input?: number, total?: number}} [estimate] — Pi-side forwarded-conversation estimate
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number, totalTokens: number}}
 */
export function rebaseSdkUsageFields(outputTokens, estimate) {
  const input = estimate && typeof estimate.input === "number" && estimate.input > 0 ? estimate.input : 0;
  const output = typeof outputTokens === "number" && outputTokens > 0 ? outputTokens : 0;
  const total = estimate && typeof estimate.total === "number" && estimate.total > 0
    ? estimate.total
    : input + output;
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: total };
}

/** Pi tools that require a `path` argument; bridged calls often omit it. */
const PATH_REQUIRED_BRIDGE_TOOLS = new Set(["edit", "write", "read"]);

const BRIDGE_PATH_FIELD_DESCRIPTION =
  "REQUIRED. Absolute or workspace-relative path to the target file. Calls without `path` are rejected.";

/**
 * Strengthen a Pi tool schema before exposing it to the Cursor SDK so the model
 * sees `path` as required with an explicit description. TypeBox schemas are
 * serialized to plain JSON Schema (symbols stripped) for SDK compatibility.
 *
 * @param {string} toolName — Pi tool name (without pi_ prefix)
 * @param {object|undefined} schema — Pi tool.parameters
 * @returns {object}
 */
export function enhanceBridgeInputSchema(toolName, schema) {
  if (!PATH_REQUIRED_BRIDGE_TOOLS.has(toolName)) {
    return schema || { type: "object" };
  }
  let out;
  try {
    out = schema && typeof schema === "object" ? JSON.parse(JSON.stringify(schema)) : { type: "object" };
  } catch {
    out = { type: "object" };
  }
  out.type = out.type || "object";
  out.properties = out.properties && typeof out.properties === "object" ? out.properties : {};
  const pathProp = out.properties.path && typeof out.properties.path === "object" ? out.properties.path : {};
  out.properties.path = {
    ...pathProp,
    type: pathProp.type || "string",
    description: pathProp.description
      ? `${BRIDGE_PATH_FIELD_DESCRIPTION} ${pathProp.description}`
      : BRIDGE_PATH_FIELD_DESCRIPTION,
  };
  const required = new Set(Array.isArray(out.required) ? out.required : []);
  required.add("path");
  if (toolName === "edit") required.add("edits");
  out.required = [...required];
  return out;
}

/**
 * Tool-specific steering lines appended to the bridge preamble.
 *
 * @param {string[]} customToolNames — SDK names (pi_edit, pi_read, …)
 * @returns {string[]}
 */
export function bridgeToolSteeringHints(customToolNames) {
  const hints = [];
  if (customToolNames.includes("pi_edit")) {
    hints.push(
      "- pi_edit: ALWAYS include `path` (target file) and `edits` ([{ oldText, newText }, …]).",
      "  Never call pi_edit with only oldText/newText or edits — `path` is mandatory.",
    );
  }
  if (customToolNames.includes("pi_write")) {
    hints.push("- pi_write: ALWAYS include `path` (target file) and `content`.");
  }
  if (customToolNames.includes("pi_read")) {
    hints.push("- pi_read: ALWAYS include `path` (file to read).");
  }
  return hints;
}

/**
 * Normalize bridged tool args before forwarding to Pi. Maps common path aliases
 * and drops them so strict schemas (additionalProperties: false) still validate.
 *
 * @param {string} toolName — Pi tool name (without pi_ prefix)
 * @param {unknown} args
 * @returns {object}
 */
export function normalizeBridgeToolArgs(toolName, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  if (!PATH_REQUIRED_BRIDGE_TOOLS.has(toolName)) return { ...args };
  const out = { ...args };
  if (typeof out.path !== "string" || !out.path) {
    for (const key of ["file_path", "filePath", "file", "filename"]) {
      if (typeof out[key] === "string" && out[key]) {
        out.path = out[key];
        break;
      }
    }
  }
  for (const key of ["file_path", "filePath", "file", "filename"]) {
    if (key in out) delete out[key];
  }
  return out;
}

/**
 * Strengthen the SDK-facing description for tools that require `path`.
 *
 * @param {string} toolName
 * @param {string|undefined} description
 * @returns {string}
 */
export function enhanceBridgeToolDescription(toolName, description) {
  const base = description || `Pi tool: ${toolName}`;
  if (toolName === "edit") {
    return `${base} Required arguments: path (string), edits (array of { oldText, newText }).`;
  }
  if (toolName === "write") {
    return `${base} Required arguments: path (string), content (string).`;
  }
  if (toolName === "read") {
    return `${base} Required argument: path (string).`;
  }
  return base;
}

function toolResultText(msg) {
  const content = msg && msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && part.type === "text" && typeof part.text === "string") return part.text;
    return "";
  }).filter(Boolean).join("\n");
}

/**
 * True when a Pi tool result represents the user cancelling that tool.
 *
 * Pi's agent loop turns an aborted tool execution into an error toolResult with
 * text such as "Operation aborted". Cursor's SDK live run is parked awaiting
 * that result; forwarding it as a normal tool error lets Cursor keep working
 * after the user hit Esc. Treat only the known abort phrases as cancellation so
 * ordinary tool errors still flow back to the model. This is intentionally not
 * exhaustive; non-standard abort text still falls back to the live AbortSignal.
 *
 * @param {unknown} msg
 * @returns {boolean}
 */
export function isBridgeToolAbortResult(msg) {
  if (!msg || typeof msg !== "object" || msg.role !== "toolResult") return false;
  const text = toolResultText(msg).trim();
  return /^(?:operation|request)(?: was)? aborted\.?$/i.test(text) || /^aborted\.?$/i.test(text);
}

/**
 * Map an SDK/transport error to a short, key-scrubbed, user-facing message.
 *
 * Scrubs the API key from BOTH `error.message` and `error.stack` (the stack is
 * mutated in place) so a later log of the raw error object cannot leak the key.
 * (L2)
 *
 * @param {Error|unknown} error
 * @param {string} apiKey
 * @returns {string}
 */
export function sanitizeSdkError(error, apiKey) {
  let message = error && error.message ? String(error.message) : String(error);
  if (apiKey && message.includes(apiKey)) message = message.split(apiKey).join("***");
  if (apiKey && error && typeof error.stack === "string" && error.stack.includes(apiKey)) {
    error.stack = error.stack.split(apiKey).join("***");
  }
  const lower = message.toLowerCase();
  const name = (error && error.constructor && error.constructor.name) || "";
  if (/auth|401|unauthor|api key|apikey/.test(lower) || name === "AuthenticationError") {
    return "Authentication failed. Set a Cursor API key via /login or CURSOR_API_KEY.";
  }
  if (/network|fetch failed|econn|timeout|socket/.test(lower) || name === "NetworkError") {
    return "Network error reaching Cursor — check connectivity and try again.";
  }
  if (/quota|rate|429/.test(lower) || name === "RateLimitError") {
    return "Rate limited or quota exceeded. Check your Cursor subscription.";
  }
  return `Cursor SDK error: ${message}`;
}

// ─── Model family routing (pure — shared with extensions/cursor-bridge.js) ───

/**
 * Known effort level tokens, ordered longest-first for greedy matching.
 * These appear as suffixes in cursor-agent model IDs.
 */
const EFFORT_TOKENS = ["extra-high", "xhigh", "medium", "high", "low", "none", "max"];

/**
 * Suffix string appended to an effort-tier model to indicate a thinking variant,
 * e.g. `claude-4.6-sonnet-medium-thinking`.
 */
const THINKING_SUFFIX = "-thinking";

/**
 * Strip @ context suffix from a model ID.
 * @param {string} modelId
 * @returns {string}
 */
export function stripContextSuffix(modelId) {
  if (!modelId) return modelId;
  return modelId.replace(/@[a-z0-9]+$/, "");
}

/**
 * Extract the @ context suffix from a model ID.
 * @param {string} modelId
 * @returns {string|null} e.g. "@1m", "@272k", or null
 */
export function extractContextSuffix(modelId) {
  if (!modelId) return null;
  const m = modelId.match(/@[a-z0-9]+$/);
  return m ? m[0] : null;
}

/**
 * Parse a raw cursor-agent model ID into its constituent parts.
 *
 * Returns `null` for models that cannot be parsed (no effort token detected),
 * UNLESS the model is a boolean-thinking variant (e.g. `claude-4.5-sonnet-thinking`)
 * where the `-thinking` suffix alone signals the thinking variant.
 *
 * @param {string} modelId — raw model ID from cursor-agent (e.g. "gpt-5.5-high")
 * @returns {{ base: string, effort: string|null, isThinking: boolean, isFast: boolean, originalModelId: string } | null}
 */
export function parseModelId(modelId) {
  if (!modelId || modelId === "auto") return null;

  // 0. Strip @ context suffix (Pi model ID convention, before any parsing)
  let id = modelId;
  const contextSuffix = extractContextSuffix(id);
  if (contextSuffix) {
    id = stripContextSuffix(id);
  }

  // 1. Strip -fast suffix (orthogonal speed modifier, deferred)
  let isFast = false;
  if (id.endsWith("-fast")) {
    id = id.slice(0, -5);
    isFast = true;
  }

  // 2. Detect -thinking suffix (thinking variant appended to an effort tier)
  let hasThinkingSuffix = false;
  if (id.endsWith(THINKING_SUFFIX)) {
    hasThinkingSuffix = true;
    id = id.slice(0, -THINKING_SUFFIX.length);
  }

  // 3. Try to match an effort token from the right
  for (const token of EFFORT_TOKENS) {
    const suffix = `-${token}`;
    if (id.endsWith(suffix)) {
      const base = id.slice(0, -suffix.length);
      if (!base) continue;

      // 4. Detect thinking infix/suffix in the base.
      //    -thinking- (with trailing dash): e.g. "claude-opus-4-7-thinking-high"
      //    -thinking at end: effort was stripped after thinking infix
      let baseName = base;
      let isThinkingInfix = false;

      const thinkingInfixPattern = "-thinking-";
      const tiIdx = base.lastIndexOf(thinkingInfixPattern);
      if (tiIdx !== -1) {
        baseName = base.slice(0, tiIdx);
        isThinkingInfix = true;
      } else {
        const thinkingSuffixOnBase = "-thinking";
        if (base.endsWith(thinkingSuffixOnBase) && base.length > thinkingSuffixOnBase.length) {
          const tsIdx = base.lastIndexOf(thinkingSuffixOnBase);
          const beforeThinking = base.slice(0, tsIdx);
          if (beforeThinking && beforeThinking.length > 0 && beforeThinking.includes("-")) {
            baseName = beforeThinking;
            isThinkingInfix = true;
          }
        }
      }

      const family = isThinkingInfix ? `${baseName}-thinking` : baseName;

      return {
        base: family,
        effort: token,
        isThinking: isThinkingInfix || hasThinkingSuffix,
        originalModelId: modelId,
        isFast,
      };
    }
  }

  // 5. Boolean-thinking model: -thinking suffix, no effort token
  //    e.g. "claude-4.5-sonnet-thinking"
  if (hasThinkingSuffix && id) {
    if (id.indexOf("-") !== -1 || /^[a-z]/.test(id)) {
      return {
        base: id,
        effort: null,
        isThinking: true,
        originalModelId: modelId,
        isFast,
      };
    }
  }

  // No effort token found — standalone model
  return null;
}

/**
 * Group raw cursor-agent model objects into families and build the variant map.
 *
 * @param {Array<{ id: string }>} models — raw model objects from fetchCursorModels()
 * @returns {{ families: Map<string, object>, variantMap: object, standaloneModels: string[] }}
 */
export function buildModelFamilies(models) {
  const families = new Map();
  const variantMap = {};
  const standaloneSet = new Set();
  let standaloneModels = [];

  // Phase 1: Parse each model and group into families
  for (const m of models) {
    if (!m.id || m.id.startsWith("_")) continue;
    const parsed = parseModelId(m.id);
    if (!parsed) { standaloneSet.add(m.id); continue; }

    const { base, effort, isThinking, originalModelId } = parsed;

    if (!families.has(base)) {
      families.set(base, {
        variants: {},
        thinkingVariants: {},
        booleanThinkingVariant: null,
        hasNonThinking: false,
      });
    }

    const family = families.get(base);
    if (isThinking && effort === null) {
      family.booleanThinkingVariant = originalModelId;
    } else if (isThinking) {
      family.thinkingVariants[effort] = originalModelId;
    } else {
      family.variants[effort] = originalModelId;
      family.hasNonThinking = true;
    }
  }

  // Phase 2: Build variantMap from families
  for (const [base, family] of families) {
    const entry = { variants: {}, thinkingVariants: {}, defaultVariant: null };
    Object.assign(entry.variants, family.variants);
    Object.assign(entry.thinkingVariants, family.thinkingVariants);

    if (family.booleanThinkingVariant) {
      entry.thinkingVariants.on = family.booleanThinkingVariant;
    }

    const vKeys = Object.keys(entry.variants);
    const tKeys = Object.keys(entry.thinkingVariants);

    if (entry.variants.medium) entry.defaultVariant = entry.variants.medium;
    else if (entry.variants.high) entry.defaultVariant = entry.variants.high;
    else if (vKeys.length > 0) entry.defaultVariant = entry.variants[vKeys[0]];
    else if (tKeys.length > 0) entry.defaultVariant = entry.thinkingVariants[tKeys[0]];

    if (vKeys.length > 0 || tKeys.length > 0) {
      variantMap[base] = entry;
    } else {
      standaloneSet.add(base);
    }
  }

  // Phase 3: Link standalone models that match family base names
  standaloneModels = [...standaloneSet];
  for (const [base] of families) {
    const entry = variantMap[base];
    if (!entry) continue;

    // If a standalone model shares the base name, link it into the family
    const ntIdx = standaloneModels.indexOf(base);
    if (ntIdx !== -1) {
      entry.variants.off = base;
      entry.defaultVariant = base;
      standaloneModels.splice(ntIdx, 1);
    }
  }

  return { families, variantMap, standaloneModels };
}

/**
 * Resolve the effective cursor-agent model ID given a collapsed family ID
 * and an optional reasoning_effort value from the request body.
 *
 * @param {string} familyId — collapsed base model ID (without variant suffix)
 * @param {string|undefined} reasoningEffort — reasoning_effort from request body
 * @param {object} variantMap — from buildModelFamilies()
 * @returns {string|null} — resolved model ID, or null if no match
 */
export function resolveModelVariant(familyId, reasoningEffort, variantMap) {
  const entry = variantMap[familyId];
  if (!entry) return null;

  // No reasoning_effort or "off": use default non-thinking variant
  if (!reasoningEffort || reasoningEffort === "off") {
    return entry.defaultVariant || null;
  }

  // reasoning_effort present and not "off": try thinking variant first
  if (entry.thinkingVariants[reasoningEffort]) {
    return entry.thinkingVariants[reasoningEffort];
  }

  // Fall back to non-thinking variant at this effort
  if (entry.variants[reasoningEffort]) {
    return entry.variants[reasoningEffort];
  }

  return null;
}
