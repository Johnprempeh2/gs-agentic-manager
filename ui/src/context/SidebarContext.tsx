import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface SidebarContextValue {
  // Mobile drawer + back-compat (existing behavior, unchanged).
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  isMobile: boolean;
  // Desktop rail state. The user's choice is remembered between sessions.
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
  toggleCollapsed: () => void;
  // Forced route states can lock the rail so a user toggle cannot override it.
  collapseLocked: boolean;
  // Fine-pointer devices can temporarily peek the full sidebar from the rail.
  peeking: boolean;
  setPeeking: (next: boolean) => void;
  // A route can force the compact rail for focused surfaces.
  forceCollapsed: boolean;
  setForceCollapsed: (next: boolean) => void;
  // A route can request a compact default until the user saves a preference.
  routeRequestsCollapsed: boolean;
  setRouteRequestsCollapsed: (next: boolean) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

const MOBILE_BREAKPOINT = 768;
const COLLAPSED_STORAGE_KEY = "paperclip.sidebar.collapsed";
const PEEK_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

function readStoredCollapsed(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    // Storage can be unavailable in private contexts.
  }
  return null;
}

function writeStoredCollapsed(value: boolean) {
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Keep the current-session state when storage is unavailable.
  }
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= MOBILE_BREAKPOINT);

  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(() => readStoredCollapsed());
  const [routeRequestsCollapsed, setRouteRequestsCollapsed] = useState(false);
  const [forceCollapsed, setForceCollapsed] = useState(false);
  const [rawPeeking, setRawPeeking] = useState(false);
  const [pointerCanPeek, setPointerCanPeek] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia(PEEK_POINTER_QUERY).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      setSidebarOpen(!e.matches);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const media = window.matchMedia(PEEK_POINTER_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      setPointerCanPeek(event.matches);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const pinnedOrRequested = userCollapsed ?? routeRequestsCollapsed;
  const collapsed = !isMobile && (forceCollapsed || pinnedOrRequested);
  const collapseLocked = !isMobile && forceCollapsed;
  const peeking = rawPeeking && collapsed && pointerCanPeek;
  const setCollapsed = useCallback((next: boolean) => {
    setUserCollapsed(next);
    writeStoredCollapsed(next);
  }, []);
  const toggleCollapsed = useCallback(() => {
    if (forceCollapsed) return;
    setCollapsed(!pinnedOrRequested);
  }, [forceCollapsed, pinnedOrRequested, setCollapsed]);
  const setPeeking = useCallback((next: boolean) => setRawPeeking(next), []);

  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  const value = useMemo<SidebarContextValue>(
    () => ({
      sidebarOpen,
      setSidebarOpen,
      toggleSidebar,
      isMobile,
      collapsed,
      setCollapsed,
      toggleCollapsed,
      collapseLocked,
      peeking,
      setPeeking,
      forceCollapsed,
      setForceCollapsed,
      routeRequestsCollapsed,
      setRouteRequestsCollapsed,
    }),
    [
      sidebarOpen,
      setSidebarOpen,
      toggleSidebar,
      isMobile,
      collapsed,
      setCollapsed,
      toggleCollapsed,
      collapseLocked,
      peeking,
      setPeeking,
      forceCollapsed,
      setForceCollapsed,
      routeRequestsCollapsed,
      setRouteRequestsCollapsed,
    ],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    throw new Error("useSidebar must be used within SidebarProvider");
  }
  return ctx;
}
