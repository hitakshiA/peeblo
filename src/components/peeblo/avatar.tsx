"use client";

import { useEffect, useRef } from "react";
import type { AvatarMotion } from "open-bot-avatar";
import { mountAvatar, type MountedAvatar } from "open-bot-avatar/dom";
import { avatarById } from "@/avatars";
import { cn } from "@/lib/utils";

type Props = {
  id: string;
  size?: number;
  mood?: AvatarMotion;
  follow?: boolean;
  still?: boolean;
  className?: string;
  label?: string;
  onMount?: (api: MountedAvatar | null) => void;
};

// A live Open Bot Avatar. Decorative unless given a label.
export function Avatar({ id, size = 64, mood = "idle", follow = true, still = false, className, label = "", onMount }: Props) {
  const host = useRef<HTMLSpanElement>(null);
  const live = useRef<MountedAvatar | null>(null);

  useEffect(() => {
    const avatar = avatarById(id);
    if (!avatar || !host.current) return;
    live.current = mountAvatar(host.current, {
      definition: avatar.definition,
      color: avatar.color,
      mood,
      followPointer: follow,
      still,
      label,
    });
    onMount?.(live.current);
    return () => {
      onMount?.(null);
      live.current?.destroy();
      live.current = null;
    };
    // mood is applied by the effect below without remounting
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, follow, still, label]);

  useEffect(() => {
    live.current?.update({ mood });
  }, [mood]);

  return (
    <span
      ref={host}
      className={cn("pb-avatar", className)}
      style={{ width: size, height: size }}
      aria-hidden={label === "" ? true : undefined}
    />
  );
}
