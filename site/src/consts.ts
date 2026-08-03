/** Shared site metadata. One place, so the head tags and the social card agree. */

export const SITE = {
  name: 'Libero',
  url: 'https://getlibero.com',
  repo: 'https://github.com/getlibero/libero',
  /**
   * Permanent invite — never expires, unlimited uses. Also the target of the
   * /discord redirect in astro.config.mjs, which is the form to hand out when
   * a link has to be spoken or typed. Anything that renders a clickable link
   * should use this constant directly and skip the hop.
   */
  discord: 'https://discord.gg/7JXpyBa6ZJ',
  tagline: 'The open-source AI teammate for Slack.',
  /**
   * The default meta description, so it has to survive a search result: keep it
   * under ~160 characters or Google truncates the tail mid-sentence. The longer
   * version of this claim — approvals included — is the homepage hero, which is
   * not length-bound.
   */
  description:
    'A self-hosted AI teammate for Slack channels. Credentials never enter the agent process, and every tool call is checked against a per-channel allowlist.',
  /** Alt text for /og.png, which is the social card for every page on both surfaces. */
  ogImageAlt:
    'Libero — the open-source AI teammate for Slack. Self-hosted, credential-isolated, every tool call audited.',
  /** Phase 0 — stated on every surface rather than implied. */
  status: 'Phase 0 · pre-release',
} as const;
