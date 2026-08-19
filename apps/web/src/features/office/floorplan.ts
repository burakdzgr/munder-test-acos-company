// Floorplan derivation (36 §7 — U04): PURE geometry computed client-side
// from the server layout (T25 auto-layout). The server stays the authority
// on zones/desks/paths (N2 — rendering only changes *how* the floor looks,
// never why anything moves); walls, doors, corridor, lobby and props are a
// deterministic visual derivation of those same zone rects. No Pixi here —
// the office lint rule reserves rendering APIs for the Pixi bridge.
import type { OfficeDesk, OfficeLayout } from "@acos/contracts";
import { departmentColors } from "@acos/ui";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type WallSegment = Rect;

export interface DoorSpec {
  x: number;
  y: number;
  w: number;
}

export type PropKind =
  | "rack"
  | "plant"
  | "coffee"
  | "meeting_table"
  | "reception"
  | "bookshelf"
  | "watercooler"
  | "cabinet"
  | "whiteboard"
  | "rug"
  | "sofa";
export interface PropSpec {
  kind: PropKind;
  x: number;
  y: number;
}

export interface RoomSpec {
  zoneId: string;
  rect: Rect;
  /** department accent hex (36 §2) — deterministic per zone order. */
  accent: string;
  label: string;
  desks: OfficeDesk[];
  door: DoorSpec;
}

export interface MeetingSpec {
  rect: Rect;
  label: string;
}

export interface Floorplan {
  /** outer-wall envelope (all zones + margin), in cell units. */
  bounds: Rect;
  rooms: RoomSpec[];
  meeting: MeetingSpec | null;
  /** every wall segment (outer + room partitions), door gaps already cut. */
  walls: WallSegment[];
  entrance: DoorSpec;
  props: PropSpec[];
}

export const WALL = 0.8; // wall thickness (cells)
export const DOOR_W = 3; // door gap width (cells)
const MARGIN = 1; // envelope margin around the zones (dış duvar + dar kaldırım)

const ACCENTS = [
  departmentColors.engineering,
  departmentColors.product,
  departmentColors.marketing,
  departmentColors.operations,
  departmentColors.sales,
  departmentColors.support,
];

/** #rrggbb lightened/darkened by delta per channel (mockup shade()). */
export function shade(hex: string, delta: number): string {
  const n = parseInt(hex.slice(1), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  const r = clamp((n >> 16) + delta);
  const g = clamp(((n >> 8) & 255) + delta);
  const b = clamp((n & 255) + delta);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/** Perimeter wall segments for a rect with one door gap cut into an edge. */
function wallsWithDoor(rect: Rect, door: DoorSpec, edge: "top" | "bottom"): WallSegment[] {
  const { x, y, w, h } = rect;
  const segments: WallSegment[] = [
    { x, y, w: WALL, h }, // left
    { x: x + w - WALL, y, w: WALL, h }, // right
  ];
  const full = (edgeY: number): WallSegment => ({ x, y: edgeY, w, h: WALL });
  const split = (edgeY: number): WallSegment[] => [
    { x, y: edgeY, w: door.x - x, h: WALL },
    { x: door.x + door.w, y: edgeY, w: x + w - (door.x + door.w), h: WALL },
  ];
  segments.push(...(edge === "top" ? split(y) : [full(y)]));
  segments.push(...(edge === "bottom" ? split(y + h - WALL) : [full(y + h - WALL)]));
  return segments.filter((s) => s.w > 0.01 && s.h > 0.01);
}

function centeredDoor(rect: Rect, edgeY: number): DoorSpec {
  return { x: rect.x + rect.w / 2 - DOOR_W / 2, y: edgeY, w: DOOR_W };
}

export function computeFloorplan(layout: OfficeLayout): Floorplan {
  const roomZones = layout.zones.filter(
    (z) => z.kind === "department" || z.kind === "team" || z.kind === "executive",
  );
  const meetingZone = layout.zones.find((z) => z.kind === "meeting") ?? null;

  const all = layout.zones.map((z) => z.rect);
  const minX = Math.min(...all.map((r) => r.x)) - MARGIN;
  const minY = Math.min(...all.map((r) => r.y)) - MARGIN;
  const maxX = Math.max(...all.map((r) => r.x + r.w)) + MARGIN;
  const maxY = Math.max(...all.map((r) => r.y + r.h)) + MARGIN;
  const bounds: Rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };

  const rooms: RoomSpec[] = roomZones.map((zone, i) => {
    const door = centeredDoor(zone.rect, zone.rect.y + zone.rect.h - WALL);
    const accent =
      zone.color ??
      (zone.kind === "executive" ? departmentColors.executive : ACCENTS[i % ACCENTS.length]!);
    return {
      zoneId: zone.id,
      rect: zone.rect,
      accent,
      label: zone.label ?? zone.id,
      desks: zone.desks ?? [],
      door,
    };
  });

  const meeting: MeetingSpec | null = meetingZone
    ? { rect: meetingZone.rect, label: meetingZone.label ?? "Toplantı" }
    : null;

  const entrance = centeredDoor(bounds, bounds.y + bounds.h - WALL);
  const walls: WallSegment[] = [
    ...wallsWithDoor(bounds, entrance, "bottom"),
    ...rooms.flatMap((room) => wallsWithDoor(room.rect, room.door, "bottom")),
    ...(meetingZone
      ? wallsWithDoor(meetingZone.rect, centeredDoor(meetingZone.rect, meetingZone.rect.y), "top")
      : []),
  ];

  // 2026-08-18 sanat turu (AGENTDESK referansı): her oda dekorlu — beyaz
  // tahta üst duvarda, sağ şerit (masalar sol-üstten dolar, sağ kenar boş)
  // kitaplık/dolap/rack'e ayrılır; lobiye kanepe + halı, toplantı yanına
  // su sebili. Yerleşim deterministik — aynı layout aynı ofisi verir.
  const props: PropSpec[] = [];
  rooms.forEach((room, i) => {
    const { x, y, w, h } = room.rect;
    props.push({ kind: "plant", x: x + w - 2, y: y + h - 3 });
    props.push({ kind: "whiteboard", x: x + 1.1, y: y + 1.05 });
    if (i === 0) {
      props.push({ kind: "rack", x: x + w - 2.4, y: y + 1.2 });
      if (h > 6) props.push({ kind: "bookshelf", x: x + w - 2.3, y: y + 3.2 });
    } else if (i % 2 === 1) {
      props.push({ kind: "cabinet", x: x + w - 2.3, y: y + 1.2 });
    } else {
      props.push({ kind: "bookshelf", x: x + w - 2.3, y: y + 1.1 });
    }
  });
  if (meeting) {
    props.push({
      kind: "meeting_table",
      x: meeting.rect.x + meeting.rect.w / 2,
      y: meeting.rect.y + meeting.rect.h / 2,
    });
    // hepsi toplantının SAĞINA: oda x=1'e dayandı, solda dış duvar var
    props.push({ kind: "coffee", x: meeting.rect.x + meeting.rect.w + 1.2, y: meeting.rect.y + 1 });
    props.push({ kind: "watercooler", x: meeting.rect.x + meeting.rect.w + 2.6, y: meeting.rect.y + 1 });
    props.push({ kind: "plant", x: meeting.rect.x + meeting.rect.w + 1.1, y: meeting.rect.y + 3 });
  }
  // lobby: reception desk beside the entrance, inside the outer wall
  props.push({ kind: "reception", x: entrance.x - 7, y: bounds.y + bounds.h - 4.2 });
  props.push({ kind: "rug", x: entrance.x + entrance.w / 2 - 1, y: bounds.y + bounds.h - 3.6 });
  props.push({ kind: "sofa", x: entrance.x + entrance.w + 1.6, y: bounds.y + bounds.h - 3.4 });
  props.push({ kind: "plant", x: entrance.x + entrance.w + 4.2, y: bounds.y + bounds.h - 3.6 });

  return { bounds, rooms, meeting, walls, entrance, props };
}
