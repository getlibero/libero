/**
 * Syntax highlighting for the docs, built from the design tokens.
 *
 * The design system allows exactly three colours and they all mean something:
 * green = allowed and executed, amber = awaiting a human, red = blocked.
 * Colouring a string literal green would be decoration, and decoration is the
 * one thing the palette is not for. So code is monochrome — the four text
 * weights carry the structure instead:
 *
 *   --lb-text        keywords, tags, the load-bearing words
 *   --lb-text-soft   identifiers, strings, values — the default
 *   --lb-text-muted  punctuation and operators
 *   --lb-text-dim    comments
 *
 * Values are read from design/tokens.css rather than typed in, because a
 * TextMate theme cannot hold a CSS variable. See ./design-tokens.mjs.
 */

import { token } from './design-tokens.mjs';

/**
 * @param {'dark' | 'light'} mode
 * @returns {Record<string, unknown>}
 */
function theme(mode) {
  const t = /** @param {string} name */ (name) => token(mode, name);

  const text = t('--lb-text');
  const soft = t('--lb-text-soft');
  const muted = t('--lb-text-muted');
  const dim = t('--lb-text-dim');

  return {
    name: `libero-${mode}`,
    type: mode,
    colors: {
      'editor.background': t('--lb-bg-surface'),
      'editor.foreground': soft,
    },
    tokenColors: [
      {
        scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
        settings: { foreground: dim },
      },
      {
        scope: [
          'keyword',
          'storage',
          'storage.type',
          'keyword.control',
          'keyword.operator.new',
          'entity.name.tag',
          'markup.heading',
          'support.type.property-name.toml',
          'variable.other.readwrite.alias', // YAML keys
        ],
        settings: { foreground: text },
      },
      {
        scope: [
          'punctuation',
          'meta.brace',
          'keyword.operator',
          'punctuation.definition.string',
          'punctuation.separator',
          'punctuation.terminator',
        ],
        settings: { foreground: muted },
      },
      {
        scope: [
          'string',
          'constant',
          'constant.numeric',
          'variable',
          'entity.name.function',
          'entity.name.type',
          'support',
          'meta.object-literal.key',
          'entity.other.attribute-name',
        ],
        settings: { foreground: soft },
      },
      {
        scope: ['invalid', 'invalid.illegal'],
        settings: { foreground: t('--lb-danger') },
      },
    ],
  };
}

export const liberoDark = theme('dark');
export const liberoLight = theme('light');

/**
 * Chrome around the code — frames, borders, copy button. These take CSS
 * variables, so one set of values covers both modes.
 */
export const styleOverrides = {
  borderRadius: 'var(--lb-radius)',
  borderColor: 'var(--lb-border)',
  borderWidth: '1px',
  codeBackground: 'var(--lb-bg-surface)',
  codeFontFamily: 'var(--lb-font-mono)',
  codeFontSize: '13px',
  codeLineHeight: '1.7',
  uiFontFamily: 'var(--lb-font-sans)',
  uiFontSize: '12px',
  focusBorder: 'var(--lb-accent)',
  // No shadows and no gradients, in either mode.
  frames: {
    shadowColor: 'transparent',
    editorTabBarBackground: 'var(--lb-bg-raised)',
    editorTabBarBorderBottomColor: 'var(--lb-border)',
    editorActiveTabBackground: 'var(--lb-bg-surface)',
    editorActiveTabForeground: 'var(--lb-text)',
    editorActiveTabIndicatorTopColor: 'var(--lb-accent)',
    editorActiveTabBorderColor: 'var(--lb-border)',
    editorTabBarBorderColor: 'var(--lb-border)',
    terminalBackground: 'var(--lb-bg-surface)',
    terminalTitlebarBackground: 'var(--lb-bg-raised)',
    terminalTitlebarBorderBottomColor: 'var(--lb-border)',
    terminalTitlebarForeground: 'var(--lb-text-muted)',
    inlineButtonBackground: 'var(--lb-bg-raised)',
    inlineButtonBorder: 'var(--lb-border-strong)',
    inlineButtonForeground: 'var(--lb-text-muted)',
    tooltipSuccessBackground: 'var(--lb-accent)',
    tooltipSuccessForeground: 'var(--lb-accent-ink)',
  },
};
