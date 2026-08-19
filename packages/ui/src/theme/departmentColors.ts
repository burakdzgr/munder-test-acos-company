// Department accent map (36 §2) — org zones, avatars, cost bars.
export const departmentColors = {
  engineering: "#4c9aff",
  product: "#a879ff",
  marketing: "#ff8a5c",
  operations: "#3fd0a0",
  sales: "#ffcb47",
  support: "#ff6b8a",
  executive: "#c9d1d9",
} as const;

export type Department = keyof typeof departmentColors;

export function departmentColor(department: string): string {
  return (departmentColors as Record<string, string>)[department] ?? departmentColors.executive;
}
