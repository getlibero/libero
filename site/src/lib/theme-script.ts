/**
 * The theme bootstrap, shared verbatim by the marketing layout and the
 * Starlight ThemeProvider override so the two surfaces cannot disagree.
 *
 * Dark is the default and needs no stored preference; light is a peer the
 * reader opts into. There is no "auto": the design system states a default,
 * and deferring to the OS would mean the site has two defaults depending on
 * whose machine it renders on. Starlight's three-way picker is replaced by a
 * two-state toggle for the same reason — see components/overrides/ThemeSelect.astro.
 *
 * Inlined into <head> as a blocking script: anything deferred flashes the
 * wrong theme first.
 */
export const THEME_STORAGE_KEY = 'starlight-theme';

export const themeScript = `
  (() => {
    let stored = null;
    try { stored = localStorage.getItem('${THEME_STORAGE_KEY}'); } catch {}
    document.documentElement.dataset.theme = stored === 'light' ? 'light' : 'dark';
  })();
`;
