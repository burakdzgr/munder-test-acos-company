import type { Config } from "tailwindcss";
import { acosPreset } from "@acos/ui";

export default {
  presets: [acosPreset as unknown as Config],
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"],
} satisfies Config;
