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
      },
      borderRadius: {
        DEFAULT: "10px",
      },
      fontFamily: {
        sans: ["DM Sans", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;