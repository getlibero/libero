/** Shared site metadata. One place, so the head tags and the social card agree. */

export const SITE = {
  name: 'Libero',
  url: 'https://getlibero.com',
  repo: 'https://github.com/getlibero/libero',
  tagline: 'The open-source AI teammate for Slack.',
  description:
    'A self-hosted AI teammate that lives in Slack channels. Credentials never enter the agent process, every tool call is checked against a per-channel allowlist, and dangerous calls wait for a human click.',
  /** Phase 0 — stated on every surface rather than implied. */
  status: 'Phase 0 · pre-release',
} as const;
