import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, MonitorSmartphone } from "lucide-react";
import { authApi, type SignedInDevice } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { relativeTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/** "Chrome on Windows" from a user agent; a plain fallback when it is unknown. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : /curl\/|node|undici|python|Go-http/i.test(ua)
              ? "A script"
              : "A browser";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iPhone or iPad"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Profile > Where you are signed in. Each live session with its device, place
 * (address) and last use, so a person can spot one they do not recognise and
 * sign it out, or sign out everywhere but here.
 */
export function SignedInDevicesSection() {
  const queryClient = useQueryClient();
  const devices = useQuery({ queryKey: queryKeys.auth.devices, queryFn: () => authApi.listSessions(), retry: false });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.auth.devices });
  const signOutOne = useMutation({ mutationFn: (id: string) => authApi.signOutDevice(id), onSuccess: refresh });
  const signOutOthers = useMutation({ mutationFn: () => authApi.signOutOtherDevices(), onSuccess: refresh });

  if (devices.isLoading) return null;
  const rows: SignedInDevice[] = devices.data ?? [];
  const others = rows.filter((row) => !row.current);
  const error = devices.error ?? signOutOne.error ?? signOutOthers.error;

  return (
    <section className="space-y-4" aria-labelledby="signed-in-devices-heading">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <h2 id="signed-in-devices-heading" className="flex items-center gap-2 text-sm font-semibold">
            <MonitorSmartphone className="size-4 text-muted-foreground" />
            Where you are signed in
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            If you see a device you do not recognise, sign it out and change your password.
          </p>
        </div>
        {others.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => signOutOthers.mutate()}
            disabled={signOutOthers.isPending}
          >
            {signOutOthers.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Sign out everywhere else
          </Button>
        ) : null}
      </div>
      {rows.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-2 font-medium">
                  {describeDevice(row.userAgent)}
                  {row.current ? <Badge variant="secondary">This device</Badge> : null}
                </div>
                <div className="text-muted-foreground">
                  {row.ipAddress ? `${row.ipAddress} · ` : ""}last used {relativeTime(row.lastActiveAt)}
                </div>
              </div>
              {row.current ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => signOutOne.mutate(row.id)}
                  disabled={signOutOne.isPending}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Could not load where you are signed in."}
        </p>
      ) : null}
    </section>
  );
}
