// Vite auto-detects this file at the project root and runs the listed
// PostCSS plugins over every CSS file it imports. Tailwind's plugin
// reads `tailwind.config.js` from the same root; autoprefixer adds
// vendor prefixes for any non-Tailwind authored CSS that still ships.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
