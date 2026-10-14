import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#F7F8FA",
        surface: "#FFFFFF",
        primary: {
          DEFAULT: "rgb(var(--color-primary) / <alpha-value>)",
          hover: "rgb(var(--color-primary-hover) / <alpha-value>)",
        },
        success: "#16A34A",
        warning: "#D97706",
        danger: "#DC2626",
        ink: "#101827",
        muted: "#667085",
        // Marketing site
        paper: "#FAF8F3",
        navy: "#0B1730",
      },
      borderRadius: {
        DEFAULT: "10px",
      },
      keyframes: {
        rise: { from: { opacity: "0", transform: "translateY(10px)" }, to: { opacity: "1", transform: "translateY(0)" } },
      },
      animation: { rise: "rise 0.6s cubic-bezier(0.2, 0.7, 0.2, 1) both" },
      fontFamily: {
        sans: ["Inter Variable", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        display: ["Fraunces Variable", "Georgia", "Cambria", "Times New Roman", "serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;