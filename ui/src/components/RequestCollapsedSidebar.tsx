import { useEffect } from "react";
import { useSidebar } from "../context/SidebarContext";

/**
 * Requests the compact desktop rail as the route default. A saved user choice
 * still wins, and cleanup clears the request when the route unmounts.
 *
 * Drop it anywhere inside a route's element tree:
 *
 * ```tsx
 * function MyPluginPage() {
 *   return (
 *     <>
 *       <RequestCollapsedSidebar />
 *       …
 *     </>
 *   );
 * }
 * ```
 */
export function RequestCollapsedSidebar() {
  const { setRouteRequestsCollapsed } = useSidebar();

  useEffect(() => {
    setRouteRequestsCollapsed(true);
    return () => setRouteRequestsCollapsed(false);
  }, [setRouteRequestsCollapsed]);

  return null;
}
