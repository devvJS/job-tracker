import defaultTheme from "tailwindcss/defaultTheme";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // The devvjs.dev portfolio palette.
      colors: {
        charcoal: "#0d0f12",
        ink: "#e2e8f0",
        muted: "#4a5568",
        accent: { green: "#39ff14", cyan: "#00e5ff" },
      },
      fontFamily: {
        sans: ["Inter", ...defaultTheme.fontFamily.sans],
        mono: ["JetBrains Mono", ...defaultTheme.fontFamily.mono],
      },
    },
  },
  plugins: [],
};
