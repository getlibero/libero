/**
 * Reads the design system's custom properties out of `design/tokens.css` and
 * the derived-token block in `design/libero.css`.
 *
 * The design rule is "reference tokens by name, never by hex". CSS honours
 * that with `var(--lb-…)`, but a few places cannot take a CSS variable — the
 * syntax-highlighting theme and the social card are both compiled to literal
 * colours at build time. Rather than transcribe hexes into this repo and let
 * them drift, those places read the values from the stylesheets themselves.
 *
 * If a token is renamed upstream, `token()` throws at build time instead of
 * silently rendering the wrong colour.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DESIGN_DIR = new URL('../../../design/', import.meta.url);

/**
 * Pull `--name: value;` pairs out of every rule whose selector list matches.
 * @param {string} css
 * @param {RegExp} selector
 * @returns {Record<string, string>}
 */
function declarations(css, selector) {
  /** @type {Record<string, string>} */
  const out = {};
  // Comments sit between rules, so they would otherwise land in the selector
  // group and stop it matching.
  const rules = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/(?<selectors>[^{}]+)\{(?<body>[^{}]*)\}/g);
  for (const rule of rules) {
    const { selectors, body } = /** @type {Record<string, string>} */ (rule.groups);
    if (!selector.test(selectors.trim())) continue;
    for (const decl of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      out[/** @type {string} */ (decl[1])] = /** @type {string} */ (decl[2]).split('/*')[0].trim();
    }
  }
  return out;
}

const files = ['tokens.css', 'libero.css'].map((name) =>
  readFileSync(fileURLToPath(new URL(name, DESIGN_DIR)), 'utf8')
);

const base = Object.assign({}, ...files.map((css) => declarations(css, /^:root$/)));
const lightOverrides = Object.assign(
  {},
  ...files.map((css) => declarations(css, /^\[data-theme="light"\]$/))
);

/** Every token, resolved for dark (the default mode). */
export const dark = base;

/** Every token, resolved for light. Light overrides only what it changes. */
export const light = { ...base, ...lightOverrides };

/**
 * Resolve one token, failing loudly if the design system no longer defines it.
 * @param {'dark' | 'light'} mode
 * @param {string} name — e.g. `--lb-text-muted`
 * @returns {string}
 */
export function token(mode, name) {
  const value = (mode === 'light' ? light : dark)[name];
  if (!value) {
    throw new Error(
      `Design token ${name} is not defined for ${mode} mode. ` +
        `It was removed or renamed in design/tokens.css or design/libero.css.`
    );
  }
  return value;
}
