// A teammate's face: the live Open Bot Avatar the landing page uses, from its shape and color. The shape comes from
// /v1/avatars/<shape>.json (Peeblo's own is bundled, so it shows before sign-in). If anything fails, it falls back to
// the server-rendered /v1/teammates/<slug>/face.png.
import { useEffect, useRef, useState } from "react";
import { validateAvatar, type AvatarDefinition, type AvatarMotion } from "open-bot-avatar";
import { mountAvatar, type MountedAvatar } from "open-bot-avatar/dom";
import { get, type Face as FaceSpec, type Teammate } from "./api";
import peebloShape from "./peeblo-avatar.json";

export const PEEBLO_FACE: FaceSpec = { shape: "peeblo", color: "#b6dfc5" };

const shapes = new Map<string, Promise<AvatarDefinition | null>>();
const bundled = validateAvatar(peebloShape);
if (bundled.ok) shapes.set("peeblo", Promise.resolve(bundled.value));

function shapeDef(name: string): Promise<AvatarDefinition | null> {
  if (!/^[a-z0-9-]+$/.test(name)) return Promise.resolve(null);
  let p = shapes.get(name);
  if (!p) {
    p = get(`/v1/avatars/${name}.json`).then((j) => {
      const r = validateAvatar(j);
      return r.ok ? r.value : null;
    });
    p.catch(() => shapes.delete(name)); // a failed fetch (e.g. signed out) is tried again next time
    shapes.set(name, p);
  }
  return p.catch(() => null);
}

// Faces by teammate slug, for places that only know a slug (a teammate page, a connector's "used by").
let faces: Promise<Map<string, FaceSpec>> | null = null;
const toMap = (ts: Teammate[]) => new Map(ts.filter((t) => t.face?.shape).map((t) => [t.slug, t.face!] as const));
export function primeFaces(ts: Teammate[]) {
  faces = Promise.resolve(toMap(ts));
}
function faceOf(slug: string): Promise<FaceSpec | null> {
  faces ??= get<{ teammates: Teammate[] }>("/v1/teammates").then(
    (r) => toMap(r.teammates),
    () => {
      faces = null;
      return new Map();
    },
  );
  return faces.then((m) => m.get(slug) ?? (slug === "peeblo" ? PEEBLO_FACE : null));
}

type Props = {
  slug: string;
  face?: FaceSpec | null;
  size?: number;
  /** false: one still drawing (lists, small chips). */
  live?: boolean;
  mood?: AvatarMotion;
  follow?: boolean;
  className?: string;
};

export function Face({ slug, face, size = 56, live = true, mood = "idle", follow = live, className = "" }: Props) {
  const host = useRef<HTMLSpanElement>(null);
  const avatar = useRef<MountedAvatar | null>(null);
  const id = `${slug}|${face?.shape ?? ""}|${face?.color ?? ""}`;
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const failed = failedFor === id;

  // id stands for slug and face, so the face remounts only when it changes; mood is applied below without remounting.
  // biome-ignore lint/correctness/useExhaustiveDependencies: id covers slug and face
  useEffect(() => {
    if (failed) return;
    let gone = false;
    (async () => {
      const f = face?.shape ? face : await faceOf(slug);
      if (!f) throw new Error("no face");
      const definition = await shapeDef(f.shape);
      if (!definition) throw new Error("no shape");
      if (gone || !host.current) return;
      avatar.current = mountAvatar(host.current, {
        definition,
        color: f.color,
        mood,
        followPointer: follow && live,
        still: !live,
        reducedMotion: "system",
        label: "",
      });
    })().catch(() => {
      if (!gone) setFailedFor(id);
    });
    return () => {
      gone = true;
      avatar.current?.destroy();
      avatar.current = null;
    };
  }, [id, live, follow, failed]);

  useEffect(() => {
    avatar.current?.update({ mood });
  }, [mood]);

  const inner = Math.round(size * 0.8);
  return (
    <span className={`face ${className}`} style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }} aria-hidden="true">
      {failed ? (
        <img
          src={`/v1/teammates/${encodeURIComponent(slug)}/face.png`}
          alt=""
          onError={(e) => {
            e.currentTarget.style.visibility = "hidden";
          }}
        />
      ) : (
        <span ref={host} className="face-live" style={{ width: inner, height: inner }} />
      )}
    </span>
  );
}
