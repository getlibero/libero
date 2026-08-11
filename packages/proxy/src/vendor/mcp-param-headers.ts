// SEP-2243 `Mcp-Param-*` header codec — vendored from the MCP TypeScript SDK.
//
// Copyright the Model Context Protocol contributors.
//
// **The applicable licence is stated rather than guessed.** The MCP project is
// mid-transition from MIT to Apache-2.0: its LICENSE says new code is
// Apache-2.0 while contributions whose authors have not consented to relicense
// remain MIT, the npm package's metadata declares MIT, and this file carries no
// SPDX marker of its own. It implements SEP-2243, which is `2026-07-28`
// material and therefore new, so Apache-2.0 is the likelier of the two. Both
// are on `scripts/license-check.sh`'s allowlist, so nothing turns on resolving
// it — and the whole upstream LICENSE, carrying both texts, is reproduced
// verbatim at ./LICENSE.modelcontextprotocol beside this file. The change note
// below is there because Apache-2.0 §4(b) requires one, which is the stricter
// of the two obligations.
//
// Source: packages/core-internal/src/shared/mcpParamHeaders.ts
// Repository: https://github.com/modelcontextprotocol/typescript-sdk
// Commit: cc4b41617ce3601b1290d67216ea0b194a3cd9ac (@modelcontextprotocol/client@2.0.0)
//
// **Why this is a copy rather than an import.** `core-internal` is
// `private: true` and is published to npm only as bundled output, so these
// functions exist in the installed package but not on its public API. Reaching
// into the bundle would be a deep import into a file whose path is a build
// artefact.
//
// **Why it is needed at all**, given the SDK implements SEP-2243 itself: the
// SDK mirrors these headers only on a `2026-07-28` connection, which is
// spec-correct because `x-mcp-header` exists only in that revision. GitHub's
// hosted server negotiates the legacy `2025-11-25` revision and *still*
// requires the headers — it declines SEP-2243's optional headerless-legacy
// courtesy — so no published SDK can call an annotated tool there. Both sides
// are within spec; the interop hole between them is real, and it is what #130
// hit. Filed upstream as modelcontextprotocol/typescript-sdk#2639. If the SDK
// ever mirrors on legacy connections, this file and its call site can go.
//
// **What was changed, and nothing else was.** The server half is not vendored:
// `validateMcpParamHeaders`, `paramHeaderMismatchRejection`, and the
// `decodeMcpParamValue` read path they use are all absent, along with the two
// imports from `./inboundClassification` that existed only to serve them and
// the two constants (`BASE64_CANONICAL`, `CANONICAL_DECIMAL`) only they read.
// That is what makes this copy import-free. Every remaining line is the SDK's,
// verbatim — do not "improve" them here.
//
// The behaviour is pinned against the SDK's own mirroring in
// ../mcp-client.test.ts, under "mirroring an argument into a request header":
// the same annotations and the same arguments go over a real connection on both
// eras and must produce the same headers. A bump that changes the encoding fails
// there rather than at an upstream that rejects our headers.

/* ------------------------------------------------------------------------ *
 * Declaration scan
 * ------------------------------------------------------------------------ */

/** The fixed prefix every custom-parameter header carries. */
export const MCP_PARAM_HEADER_PREFIX = 'Mcp-Param-';

/** The schema-extension property name a tool's `inputSchema` carries. */
export const X_MCP_HEADER_KEY = 'x-mcp-header';

/**
 * One `x-mcp-header` declaration found inside a tool's `inputSchema`.
 *
 * `path` is the property path from the arguments root (the spec permits
 * declarations at any nesting depth under `properties`); `headerName` is the
 * `{Name}` portion as declared (case preserved for emission; comparison is
 * case-insensitive); `type` is the JSON Schema `type` of the declaring
 * property.
 */
export interface XMcpHeaderDeclaration {
    path: readonly string[];
    headerName: string;
    type: string;
}

/** The result of scanning a tool's `inputSchema` for `x-mcp-header` declarations. */
export type XMcpHeaderScanResult = { valid: true; declarations: readonly XMcpHeaderDeclaration[] } | { valid: false; reason: string };

/**
 * RFC 9110 §5.1 `token` syntax (`1*tchar`). Rejects empty, space, control
 * characters (including CR/LF), and the listed delimiters.
 */
const RFC9110_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * JSON Schema `type` values the spec admits on an `x-mcp-header` property.
 *
 * The spec text names `integer`, `string`, `boolean` and explicitly excludes
 * `number`. The published conformance referee at the pinned release ships its
 * `http-custom-headers` scenario with two `type: "number"` `x-mcp-header`
 * parameters and expects the client to mirror them, so `number` is accepted
 * here so that the conformance gate passes; the discrepancy is tracked
 * upstream. Everything else (`object`, `array`, `null`, absent) is rejected.
 */
const PERMITTED_X_MCP_HEADER_TYPES: ReadonlySet<string> = new Set(['string', 'integer', 'boolean', 'number']);

/**
 * Scan a tool's JSON-serialized `inputSchema` for `x-mcp-header` declarations
 * and validate every constraint the spec places on them. Returns either the
 * collected declarations (possibly empty) or the first violated constraint.
 *
 * The walk descends through `properties` at any depth (the spec's "any nesting
 * depth" clause). The static-reachability MUST is enforced as a structural
 * sweep: every position the chain MUST NOT pass through (`items`/
 * `additionalProperties`, `oneOf`/`anyOf`/`allOf`/`not`, `if`/`then`/`else`,
 * `$defs`, `$ref` targets within `$defs`) is visited too, and an
 * `x-mcp-header` found anywhere on that path invalidates the schema — "an
 * annotation anywhere else makes the tool definition invalid".
 */
export function scanXMcpHeaderDeclarations(inputSchema: unknown): XMcpHeaderScanResult {
    const declarations: XMcpHeaderDeclaration[] = [];
    const seenLower = new Map<string, string>();

    const visit = (node: unknown, path: readonly string[], reachable: boolean): string | undefined => {
        if (node === null || typeof node !== 'object') return undefined;
        const schema = node as Record<string, unknown>;

        if (X_MCP_HEADER_KEY in schema) {
            if (!reachable || path.length === 0) {
                return `${pathName(path)}: x-mcp-header is only permitted on properties statically reachable via a chain of 'properties' keys (not under items, additionalProperties, oneOf/anyOf/allOf/not, if/then/else, or $ref)`;
            }
            const raw = schema[X_MCP_HEADER_KEY];
            if (typeof raw !== 'string' || raw.length === 0) {
                return `${pathName(path)}: x-mcp-header MUST be a non-empty string`;
            }
            if (!RFC9110_TOKEN.test(raw)) {
                return `${pathName(path)}: x-mcp-header '${raw}' is not a valid RFC 9110 token (no spaces, control characters or HTTP delimiters)`;
            }
            const type = typeof schema.type === 'string' ? schema.type : undefined;
            if (type === undefined || !PERMITTED_X_MCP_HEADER_TYPES.has(type)) {
                return `${pathName(path)}: x-mcp-header is only permitted on primitive-typed properties (string, integer, boolean); got ${type ?? '<none>'}`;
            }
            const lower = raw.toLowerCase();
            const prior = seenLower.get(lower);
            if (prior !== undefined) {
                return `x-mcp-header '${raw}' is not case-insensitively unique (also declared as '${prior}')`;
            }
            seenLower.set(lower, raw);
            declarations.push({ path, headerName: raw, type });
        }

        const properties = schema.properties;
        if (properties !== null && typeof properties === 'object') {
            for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
                const fault = visit(child, [...path, key], reachable);
                if (fault !== undefined) return fault;
            }
        }
        // Static-reachability sweep: descend the keywords the chain MUST NOT
        // pass through with `reachable: false` so an annotation under any of
        // them is reported (rather than silently ignored). `$defs` covers
        // `$ref`-within-`$defs` — chasing arbitrary `$ref` URIs is out of scope.
        for (const k of NON_REACHABLE_SUBSCHEMA_KEYWORDS) {
            const sub = schema[k];
            if (sub === undefined) continue;
            const branches: unknown[] = Array.isArray(sub)
                ? sub
                : sub !== null && typeof sub === 'object' && OBJECT_VALUED_SUBSCHEMA_KEYWORDS.has(k)
                  ? Object.values(sub as Record<string, unknown>)
                  : [sub];
            for (const branch of branches) {
                const fault = visit(branch, [...path, `<${k}>`], false);
                if (fault !== undefined) return fault;
            }
        }
        return undefined;
    };

    const fault = visit(inputSchema, [], true);
    return fault === undefined ? { valid: true, declarations } : { valid: false, reason: fault };
}

/**
 * JSON Schema keywords whose subschemas the SEP-2243 static-reachability
 * constraint excludes from the `properties`-only chain. An `x-mcp-header`
 * found under any of these invalidates the tool definition.
 */
const NON_REACHABLE_SUBSCHEMA_KEYWORDS = [
    'items',
    'prefixItems',
    'contains',
    'additionalProperties',
    'unevaluatedProperties',
    'unevaluatedItems',
    'propertyNames',
    'patternProperties',
    'dependentSchemas',
    'oneOf',
    'anyOf',
    'allOf',
    'not',
    'if',
    'then',
    'else',
    '$defs',
    'definitions'
] as const;

/**
 * Subschema-carrying keywords whose value is a `name → subschema` object
 * (not a single subschema or array of subschemas). The visit branches over
 * `Object.values()` for these.
 */
const OBJECT_VALUED_SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set(['patternProperties', 'dependentSchemas', '$defs', 'definitions']);

function pathName(path: readonly string[]): string {
    return path.length === 0 ? '<root>' : path.join('.');
}

/* ------------------------------------------------------------------------ *
 * Value encoding
 * ------------------------------------------------------------------------ */

const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';

/**
 * Convert a primitive argument value to its string representation per the
 * spec's type-conversion rules: strings pass through, integers and numbers
 * become their decimal string, booleans become lowercase `'true'` / `'false'`.
 * Non-finite numbers and integers outside the safe range are refused (the
 * caller treats `undefined` as "do not emit a header for this value").
 */
export function mcpParamPrimitiveToString(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return undefined;
        if (Number.isInteger(value) && !Number.isSafeInteger(value)) return undefined;
        return String(value);
    }
    return undefined;
}

/**
 * `true` when `s` cannot be safely represented as a plain ASCII HTTP field
 * value per RFC 9110 §5.5: it contains a byte outside `0x20–0x7E` / `0x09`, it
 * has leading or trailing whitespace (which field parsing strips), or it
 * already matches the Base64 sentinel pattern (the spec's "to avoid ambiguity"
 * rule).
 */
function needsBase64(s: string): boolean {
    if (s.length === 0) return true;
    if (s.startsWith(BASE64_SENTINEL_PREFIX) && s.endsWith(BASE64_SENTINEL_SUFFIX)) return true;
    if (s !== s.trim()) return true;
    for (let i = 0; i < s.length; i++) {
        const c = s.codePointAt(i)!;
        // Visible ASCII 0x21–0x7E, plus space 0x20 and horizontal tab 0x09; a
        // tab is only safe when it is interior whitespace (the trim() check
        // above already covered leading/trailing).
        if (c === 0x09 || (c >= 0x20 && c <= 0x7e)) continue;
        return true;
    }
    return false;
}

function utf8ToBase64(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCodePoint(b);
    return btoa(bin);
}


/**
 * Encode a string value as an HTTP field value per the spec's value-encoding
 * rules: a value that is already a safe plain-ASCII field value is passed
 * through unchanged; anything else is wrapped as `=?base64?{b64-of-utf8}?=`.
 */
export function encodeMcpParamValue(value: string): string {
    return needsBase64(value) ? `${BASE64_SENTINEL_PREFIX}${utf8ToBase64(value)}${BASE64_SENTINEL_SUFFIX}` : value;
}


/* ------------------------------------------------------------------------ *
 * Client-side header construction (the 5-step MUST algorithm, steps 3–5)
 * ------------------------------------------------------------------------ */

function valueAtPath(root: unknown, path: readonly string[]): unknown {
    let node: unknown = root;
    for (const key of path) {
        if (node === null || typeof node !== 'object') return undefined;
        node = (node as Record<string, unknown>)[key];
    }
    return node;
}

/**
 * Build the `Mcp-Param-{Name}` headers for one `tools/call` from a scan of the
 * tool's `inputSchema` and the call's `arguments`. A declaration whose value is
 * `null` or absent in `arguments` is omitted (the spec's "client MUST omit the
 * header" rows); a value that is not a primitive of the declared kind is
 * omitted rather than emitted malformed.
 */
export function buildMcpParamHeaders(
    declarations: readonly XMcpHeaderDeclaration[],
    args: Record<string, unknown> | undefined
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const decl of declarations) {
        const raw = valueAtPath(args, decl.path);
        if (raw === undefined || raw === null) continue;
        const stringValue = mcpParamPrimitiveToString(raw);
        if (stringValue === undefined) continue;
        out[`${MCP_PARAM_HEADER_PREFIX}${decl.headerName}`] = encodeMcpParamValue(stringValue);
    }
    return out;
}

/* ------------------------------------------------------------------------ *
 * Server-side validation
 * ------------------------------------------------------------------------ */
