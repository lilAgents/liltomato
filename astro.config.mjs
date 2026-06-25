import { defineConfig } from 'astro/config';

// Tailwind is wired through PostCSS (postcss.config.cjs), which Astro/Vite
// picks up automatically — no integration needed, and it installs cleanly on
// Astro 7 (the @astrojs/tailwind integration only supports Astro <= 5).
export default defineConfig({});
