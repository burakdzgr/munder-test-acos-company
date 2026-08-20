// FAZ 2B / 2B-3 — bir avatarın GÖRSEL DURUMU. Saf fonksiyon: Pixi yok.
//
// Kural (23 §4.1, FAZ 2B kararıyla teyitli): ofiste hiçbir şey kendiliğinden
// olmaz. Buradaki her çıktı, sunucudan gelmiş bir talimatın türevidir:
//   * badge  ← office.status.changed
//   * moving ← office.avatar.moved (motorun oynattığı yürüyüş)
//   * interaction ← office.interaction.started/ended
// Yani "yazıyor" görüntüsü ajanın GERÇEKTEN WORKING olmasından doğar; ekranı
// süslemek için uydurulmuş bir animasyon değildir. Munder'ın kendi kendine
// kahve molası veren yönetmeni bu yüzden taşınmadı (karar: 2B-5 YAPILMAYACAK).
import type { PresenceBadge } from "@acos/contracts";
import type { WalkDir } from "../characters.js";

export type Posture = "walking" | "seated" | "standing";
export type Activity =
  | "walking"
  | "typing"
  | "thinking"
  | "reading"
  | "talking"
  | "waiting"
  | "blocked"
  | "escalating"
  | "idle"
  | "offline";
// "wait" (2026-08-21): PARK EDEN ajanin basinda duran DURAKLAT isareti. Onceden
// WAITING rozetinin balonu "none" idi — masasinda oturan bekleyen ajan,
// masasinda oturan calisan ajandan AYIRT EDILEMIYORDU. Canli kosum
// demosunda Founder'in gormesi gereken an tam da bu.
export type Bubble = "none" | "thought" | "speech" | "review" | "alert" | "wait";

export interface VisualState {
  posture: Posture;
  activity: Activity;
  bubble: Bubble;
  /** oturuyorsa masaya dönük (yukarı) */
  facing: WalkDir;
  /** masasında mı (monitör tonlaması ve yazma bunun şartı) */
  atDesk: boolean;
  /** OFFLINE sönük çizilir */
  dim: boolean;
}

const BADGE_ACTIVITY: Record<string, { activity: Activity; bubble: Bubble }> = {
  WORKING: { activity: "typing", bubble: "none" },
  THINKING: { activity: "thinking", bubble: "thought" },
  REVIEWING: { activity: "reading", bubble: "review" },
  TESTING: { activity: "reading", bubble: "review" },
  LEARNING: { activity: "thinking", bubble: "thought" },
  COMMUNICATING: { activity: "talking", bubble: "speech" },
  WAITING: { activity: "waiting", bubble: "wait" },
  BLOCKED: { activity: "blocked", bubble: "alert" },
  ESCALATING: { activity: "escalating", bubble: "alert" },
  IDLE: { activity: "idle", bubble: "none" },
  OFFLINE: { activity: "offline", bubble: "none" },
};

export interface VisualInput {
  badge: PresenceBadge;
  /** motor bu kare avatarı oynatıyor mu */
  moving: boolean;
  /** avatar kendi koltuğunda mı (yansıtıcının verdiği hücre) */
  atSeat: boolean;
  /** avatarın içinde olduğu etkileşim (varsa) */
  interaction?: "dm" | "review" | "escalation" | "meeting" | "speech" | null;
  /** yürüyorsa yön */
  dir: WalkDir;
}

export function visualStateFor(input: VisualInput): VisualState {
  const mapped = BADGE_ACTIVITY[input.badge] ?? { activity: "idle", bubble: "none" };
  const dim = input.badge === "OFFLINE";

  if (input.moving) {
    return {
      posture: "walking",
      activity: "walking",
      // yürürken de bir şey söylüyor olabilir (etkileşim balonu korunur)
      bubble: input.interaction ? interactionBubble(input.interaction) : "none",
      facing: input.dir,
      atDesk: false,
      dim,
    };
  }

  const bubble = input.interaction ? interactionBubble(input.interaction) : mapped.bubble;

  if (input.atSeat) {
    return {
      posture: "seated",
      // masada değilken "yazıyor" gösterilemez: klavye masada
      activity: mapped.activity,
      bubble,
      facing: "up", // masaya dönük
      atDesk: true,
      dim,
    };
  }

  return {
    posture: "standing",
    activity: mapped.activity === "typing" ? "idle" : mapped.activity,
    bubble,
    facing: input.dir,
    atDesk: false,
    dim,
  };
}

function interactionBubble(kind: NonNullable<VisualInput["interaction"]>): Bubble {
  if (kind === "escalation") return "alert";
  if (kind === "review") return "review";
  return "speech";
}

/** Yazma ritmi: WORKING durumundaki avatarın omuz hareketi (kare fazı). */
export function typingOffset(activity: Activity, seconds: number): number {
  if (activity !== "typing") return 0;
  return Math.sin(seconds * 7) > 0 ? 0 : 1;
}
