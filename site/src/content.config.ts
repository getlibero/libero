import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),

  blog: defineCollection({
    loader: glob({ base: './src/content/blog', pattern: '**/*.md' }),
    schema: z.object({
      title: z.string(),
      /** Shown on the index and in the RSS feed. */
      description: z.string(),
      date: z.date(),
      /** Release notes read differently from posts; the index labels them. */
      kind: z.enum(['post', 'release']).default('post'),
    }),
  }),
};
