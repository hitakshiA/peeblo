import { useEffect, useRef, useState } from "react";
import { useInView } from "motion/react";

/** Local, silent media; offscreen/hidden/reduced-motion views keep the poster. */
export function LoopAsset({
  name,
  paused,
  className = "",
  alt,
  eager = false,
}: {
  name: "orbit" | "evidence";
  paused: boolean;
  className?: string;
  alt: string;
  eager?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const visible = useInView(host, { margin: "80px" });
  const [documentVisible, setDocumentVisible] = useState(!document.hidden);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const poster = `/images/${name === "orbit" ? "peeblo-ledger-orbit" : "peeblo-evidence"}.png`;
  const active = visible && documentVisible && !paused && !failed;
  useEffect(() => {
    const update = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (active) video.current?.play().catch(() => setReady(false));
    else video.current?.pause();
  }, [active]);
  return (
    <div className={`loop-asset ${className}`} ref={host}>
      <img
        src={poster}
        alt={alt}
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : "auto"}
      />
      {visible && !paused && !failed && (
        <video
          ref={video}
          src={`/videos/peeblo-${name}.mp4`}
          muted
          loop
          playsInline
          autoPlay={active}
          preload="metadata"
          aria-hidden="true"
          onPlaying={() => setReady(true)}
          onError={() => setFailed(true)}
          style={{ opacity: ready ? 1 : 0 }}
        />
      )}
    </div>
  );
}
