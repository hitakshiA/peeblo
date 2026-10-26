import { useEffect, useRef, type ReactNode } from "react";

export default function DraggableMarquee({
  children,
}: {
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current!;
    const track = el.querySelector<HTMLElement>(".app-marquee-track")!;
    const group = track.firstElementChild as HTMLElement;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    let width = group.offsetWidth,
      x = 0,
      velocity = -30,
      frame = 0;
    let down = false,
      dragged = false,
      pointer = -1,
      start = 0,
      last = 0,
      sample = 0,
      tick = performance.now();
    const paint = () => {
      if (!width) return;
      x = (((x % width) + width) % width) - width;
      track.style.transform = `translate3d(${x}px,0,0)`;
    };
    const resize = new ResizeObserver(() => {
      width = group.offsetWidth;
      if (!media.matches) paint();
    });
    resize.observe(group);
    const loop = (now: number) => {
      const dt = Math.min((now - tick) / 1000, 0.04);
      tick = now;
      if (!media.matches && !document.hidden && !down) {
        // Release speed decays smoothly back to the ambient leftward drift.
        velocity += (-30 - velocity) * (1 - Math.exp(-2.4 * dt));
        x += velocity * dt;
        paint();
      }
      if (media.matches) track.style.transform = "";
      frame = requestAnimationFrame(loop);
    };
    const press = (e: PointerEvent) => {
      if (media.matches || (e.pointerType === "mouse" && e.button !== 0))
        return;
      down = true;
      dragged = false;
      pointer = e.pointerId;
      start = last = e.clientX;
      sample = performance.now();
      velocity = 0;
    };
    const move = (e: PointerEvent) => {
      if (!down || e.pointerId !== pointer) return;
      if (!dragged && Math.abs(e.clientX - start) < 5) return;
      if (!dragged) {
        dragged = true;
        el.setPointerCapture(pointer);
        el.classList.add("is-dragging");
      }
      const now = performance.now(),
        dx = e.clientX - last;
      velocity = Math.max(
        -1600,
        Math.min(1600, dx / Math.max((now - sample) / 1000, 0.008)),
      );
      x += dx;
      last = e.clientX;
      sample = now;
      paint();
    };
    const release = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      down = false;
      if (performance.now() - sample > 100) velocity = 0;
      if (el.hasPointerCapture(pointer)) el.releasePointerCapture(pointer);
      el.classList.remove("is-dragging");
    };
    const click = (e: MouseEvent) => {
      if (dragged) {
        e.preventDefault();
        e.stopPropagation();
        dragged = false;
      }
    };
    const preventNativeDrag = (e: DragEvent) => e.preventDefault();
    el.addEventListener("pointerdown", press);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    el.addEventListener("click", click, true);
    el.addEventListener("dragstart", preventNativeDrag);
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      el.removeEventListener("pointerdown", press);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      el.removeEventListener("click", click, true);
      el.removeEventListener("dragstart", preventNativeDrag);
    };
  }, []);
  return (
    <div
      ref={host}
      className="app-selector"
      aria-label="Explore planned integrations. Drag to browse."
    >
      {children}
    </div>
  );
}
