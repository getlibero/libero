/**
 * The docs sidebar, defined once.
 *
 * Two consumers need it and they need different things from it:
 * astro.config.mjs renders it as navigation, and src/pages/llms.txt.ts groups
 * the link list by it. The alternative was llms.txt listing pages in collection
 * order, which is alphabetical by file id and throws away the only curation
 * this site has — "Start here" before "Concepts" before "Project" is an opinion
 * about reading order, and an agent benefits from it for the same reason a
 * person does.
 *
 * Kept in the shape Starlight's `sidebar` option takes, so the config passes it
 * through untouched and there is no mapping layer to get wrong.
 */

export interface DocsNavGroup {
  label: string;
  items: { label: string; slug: string }[];
}

export const docsNav: DocsNavGroup[] = [
  {
    label: 'Start here',
    items: [
      { label: 'What Libero is', slug: 'docs' },
      { label: 'Self-hosting', slug: 'docs/self-hosting' },
      { label: 'Deploying on a VM', slug: 'docs/deploying-on-a-vm' },
      { label: 'Connecting GitHub', slug: 'docs/github' },
    ],
  },
  {
    label: 'Concepts',
    items: [
      { label: 'Architecture', slug: 'docs/architecture' },
      { label: 'Team sheets', slug: 'docs/team-sheet' },
      { label: 'The price table', slug: 'docs/price-table' },
      { label: 'Security model', slug: 'docs/security' },
    ],
  },
  {
    label: 'Project',
    items: [
      { label: 'Roadmap', slug: 'docs/roadmap' },
      { label: 'Changelog', slug: 'docs/changelog' },
      { label: 'Contributing', slug: 'docs/contributing' },
    ],
  },
];
