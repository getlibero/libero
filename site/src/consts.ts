/** Shared site metadata. One place, so the head tags and the social card agree. */

export const SITE = {
  name: 'Libero',
  url: 'https://getlibero.com',
  repo: 'https://github.com/getlibero/libero',
  /**
   * Permanent invite — never expires, unlimited uses. The one place the invite
   * is written down, and the target of the /discord redirect in
   * astro.config.mjs.
   *
   * The site links the invite directly: it redeploys on every push, so a
   * rotated invite propagates immediately, and there is no reason to make a
   * clickable link take an extra hop.
   *
   * Everything outside site/ links https://getlibero.com/discord instead —
   * packages/cli/README.md is baked into every published version on npm, and
   * the root README, CONTRIBUTING.md, and the issue-template config are
   * mirrored and scraped far beyond our reach. Those surfaces cannot be fixed
   * after the fact, so they get the redirect. This inconsistency is the point;
   * do not "fix" it by pointing them back at the invite.
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
    'A self-hosted AI teammate for Slack channels. Tool credentials never enter the agent process, and every call is checked against a per-channel allowlist.',
  /** Alt text for /og.png, which is the social card for every page on both surfaces. */
  ogImageAlt:
    'Libero — the open-source AI teammate for Slack. Self-hosted, credential-isolated, every tool call audited.',
  /**
   * Stated on every surface rather than implied, and read from here rather than
   * retyped — a status string that lives in two places is a status string that
   * is wrong in one of them.
   *
   * Phase 2 is *in progress*, which is not the same as usable: phases 1 and
   * 1.5 are shipped, and the pre-release warning next to this on every page is
   * doing the load-bearing work. Move this on when a phase opens, not when it
   * finishes.
   */
  status: 'Phase 2 · pre-release',
} as const;
