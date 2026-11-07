"use client";

// A character that can be told where to look. Same live Open Bot Avatar as <Critter>, but a
// section can point its eyes and body at something (a hovered nav link, an anatomy part) and
// it leans that way on a spring. With no target it follows the pointer like everyone else.
// Click boops it; bump `hop` to make it hop.

import { useEffect, useRef } from "react";
import type { AvatarMotion } from "open-bot-avatar";
import type { MountedAvatar } from "open-bot-avatar/dom";
import { onFrame, reducedMotion, spring } from "@/lib/pointer";
import { cn } from "@/lib/utils";
import { Avatar } from "./avatar";

export type Look = { x: number; y: number } | null;

const HOP: Keyframe[] = [
  { transform: "scale(1)" },
  { transform: "scale(1.12, 0.84)", offset: 0.18 },
  { transform: "translateY(-22%) scale(0.94, 1.1) rotate(-4deg)", offset: 0.42 },
  { transform: "translateY(0) scale(1.08, 0.9) rotate(2deg)", offset: 0.6 },
  { transform: "scale(0.97, 1.04)", offset: 0.76 },
  { transform: "scale(1)" },
];
const BOOP: Keyframe[] = [{ transform: "scale(1)" }, { transform: "scale(1.18, 0.8)", offset: 0.3 }, { transform: "scale(0.92, 1.1)", offset: 0.6 }, { transform: "scale(1)" }];

type Props = {
  id: string;
  size?: number;
  mood?: AvatarMotion;
  look?: Look;
  lean?: number;
  bob?: boolean;
  hop?: number;
  className?: string;
};

export function GazeCritter({ id, size = 64, mood = "idle", look = null, lean = 8, bob = true, hop = 0, className }: Props) {
  const leanEl = useRef<HTMLSpanElement>(null);
  const act = useRef<HTMLSpanElement>(null);
  const api = useRef<MountedAvatar | null>(null);
  const target = useRef<Look>(look);

  useEffect(() => {
    target.current = look;
    api.current?.update({ lookAt: look });
  }, [look]);

  useEffect(() => {
    if (!hop || reducedMotion()) return;
    act.current?.animate(HOP, { duration: 780, easing: "cubic-bezier(.34,1.3,.64,1)" });
  }, [hop]);

  useEffect(() => {
    if (reducedMotion()) return;
    const sx = { x: 0, v: 0 };
    const sy = { x: 0, v: 0 };
    const sr = { x: 0, v: 0 };
    return onFrame((_now, dt) => {
      const el = leanEl.current;
      if (!el) return;
      const t = target.current;
      const moving = [spring(sx, t ? t.x * lean : 0, dt, 150, 13), spring(sy, t ? t.y * lean * 0.4 : 0, dt, 150, 13), spring(sr, t ? t.x * lean * 0.8 : 0, dt, 150, 13)].some(Boolean);
      if (moving) el.style.transform = `translate(${sx.x.toFixed(2)}px, ${sy.x.toFixed(2)}px) rotate(${sr.x.toFixed(2)}deg)`;
    });
  }, [lean]);

  const boop = () => {
    if (!reducedMotion()) act.current?.animate(BOOP, { duration: 450, easing: "cubic-bezier(.34,1.3,.64,1)" });
  };

  return (
    <span className={cn("pb-critter", className)} style={{ width: size, height: size }} onClick={boop}>
      <span ref={leanEl} className="pb-critter__lean">
        <span ref={act} className="pb-critter__act">
          <span className={cn("pb-critter__idle", bob && "is-bob")}>
            <Avatar
              id={id}
              size={size}
              mood={mood}
              onMount={(a) => {
                api.current = a;
                if (a && target.current) a.update({ lookAt: target.current });
              }}
            />
          </span>
        </span>
      </span>
    </span>
  );
}
