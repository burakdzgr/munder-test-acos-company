import { describe, expect, it } from "vitest";
import type { OfficeLayout } from "@acos/contracts";
import { DOOR_W, WALL, computeFloorplan, shade } from "./floorplan.js";

function layoutFixture(): OfficeLayout {
  return {
    version: 1,
    grid: { cellSize: 32, cols: 80, rows: 50 },
    zones: [
      {
        id: "z_eng",
        kind: "department",
        rect: { x: 2, y: 2, w: 11, h: 22 },
        label: "Engineering",
        desks: [
          { id: "d1", cell: { x: 4, y: 4 }, agentId: null },
          { id: "d2", cell: { x: 6, y: 4 }, agentId: null },
        ],
      },
      {
        id: "z_mkt",
        kind: "department",
        rect: { x: 15, y: 2, w: 9, h: 22 },
        label: "Marketing",
        desks: [],
      },
      {
        id: "z_meet",
        kind: "meeting",
        rect: { x: 2, y: 26, w: 12, h: 8 },
        label: "Meeting Area",
        spots: 6,
      },
    ],
    walls: [],
  };
}

describe("computeFloorplan", () => {
  it("derives the outer envelope from the zones plus margin", () => {
    const plan = computeFloorplan(layoutFixture());
    expect(plan.bounds.x).toBeLessThan(2);
    expect(plan.bounds.y).toBeLessThan(2);
    expect(plan.bounds.x + plan.bounds.w).toBeGreaterThan(24);
    expect(plan.bounds.y + plan.bounds.h).toBeGreaterThan(34);
  });

  it("gives every room a centered bottom door and cuts wall gaps for it", () => {
    const plan = computeFloorplan(layoutFixture());
    expect(plan.rooms).toHaveLength(2);
    for (const room of plan.rooms) {
      expect(room.door.w).toBe(DOOR_W);
      expect(room.door.x).toBeCloseTo(room.rect.x + room.rect.w / 2 - DOOR_W / 2);
      // left + right + full top + two bottom segments around the door
      const segments = plan.walls.filter(
        (s) =>
          s.x >= room.rect.x - 0.01 &&
          s.y >= room.rect.y - 0.01 &&
          s.x + s.w <= room.rect.x + room.rect.w + 0.01 &&
          s.y + s.h <= room.rect.y + room.rect.h + 0.01,
      );
      expect(segments.length).toBe(5);
      const bottom = segments.filter((s) => s.h === WALL && s.y > room.rect.y + 1);
      expect(bottom).toHaveLength(2);
      expect(bottom[0]!.w + bottom[1]!.w).toBeCloseTo(room.rect.w - DOOR_W);
    }
  });

  it("cuts an entrance into the bottom outer wall", () => {
    const plan = computeFloorplan(layoutFixture());
    const bottomY = plan.bounds.y + plan.bounds.h - WALL;
    const outerBottom = plan.walls.filter((s) => Math.abs(s.y - bottomY) < 0.01 && s.h === WALL);
    expect(outerBottom).toHaveLength(2);
    expect(plan.entrance.x).toBeCloseTo(plan.bounds.x + plan.bounds.w / 2 - DOOR_W / 2);
  });

  it("is deterministic and assigns distinct department accents in zone order", () => {
    const a = computeFloorplan(layoutFixture());
    const b = computeFloorplan(layoutFixture());
    expect(a).toEqual(b);
    expect(a.rooms[0]!.accent).not.toBe(a.rooms[1]!.accent);
  });

  it("places props: rack, per-room decor, meeting set, lobby set (2026-08-18 sanat turu)", () => {
    const plan = computeFloorplan(layoutFixture());
    const byKind = (k: string) => plan.props.filter((p) => p.kind === k);
    expect(byKind("rack")).toHaveLength(1);
    // bitki: oda başına 1 + toplantı yanı 1 + lobi 1
    expect(byKind("plant")).toHaveLength(4);
    expect(byKind("whiteboard")).toHaveLength(2); // oda başına 1
    expect(byKind("meeting_table")).toHaveLength(1);
    expect(byKind("coffee")).toHaveLength(1);
    expect(byKind("watercooler")).toHaveLength(1);
    expect(byKind("reception")).toHaveLength(1);
    expect(byKind("rug")).toHaveLength(1);
    expect(byKind("sofa")).toHaveLength(1);
  });

  it("copes with a layout without a meeting zone", () => {
    const layout = layoutFixture();
    layout.zones = layout.zones.filter((z) => z.kind !== "meeting");
    const plan = computeFloorplan(layout);
    expect(plan.meeting).toBeNull();
    expect(plan.props.some((p) => p.kind === "meeting_table")).toBe(false);
  });
});

describe("shade", () => {
  it("lightens and darkens with channel clamping", () => {
    expect(shade("#000000", 16)).toBe("#101010");
    expect(shade("#ffffff", 16)).toBe("#ffffff");
    expect(shade("#4c9aff", -20)).toBe("#3886eb");
  });
});
