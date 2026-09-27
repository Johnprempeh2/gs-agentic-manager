import { useEffect, useRef } from "react";
import { mountGreatstoneTide } from "../lib/greatstone-tide";
import { BrandMark } from "./BrandMark";

/**
 * Brand hero panel: the tide of time on the void with the outlined stone at
 * its centre. The panel stays on the void in both themes (it is the brand
 * image, not page chrome), and carries no copy: the tide's lime crest may
 * never pass behind text.
 */
export function BrandTideHero({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const tide = mountGreatstoneTide(host);
    return () => tide.destroy();
  }, []);

  return (
    <div className={`gs-tide-hero relative h-full w-full overflow-hidden ${className ?? ""}`}>
      <div ref={hostRef} className="absolute inset-0" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <BrandMark variant="outline" decorative className="gs-tide-hero-mark h-44 w-auto" />
      </div>
    </div>
  );
}
