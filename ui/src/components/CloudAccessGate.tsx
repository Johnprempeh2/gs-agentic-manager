import { Navigate, Outlet, useLocation } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { BootstrapPendingPage } from "@/components/BootstrapPendingPage";
import { BrandLoading } from "@/components/BrandLoading";
import { TwoStepSignInSection } from "@/components/TwoStepSignInSection";
import { useSignOut } from "@/hooks/useSignOut";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

function NoBoardAccessPage() {
  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">
        <h1 className="text-xl font-semibold">No organization access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This account is signed in, but it does not have an active organisation membership or instance-admin access on
          this GS Agentic Manager instance.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Use an organization invite or sign in with an account that already belongs to this org.
        </p>
      </Card>
    </div>
  );
}

/**
 * A refetch that could not reach the server keeps what was already loaded on
 * screen (the connection notice says so) instead of replacing the app with an
 * error. Any other failure, or one before anything loaded, still stops here.
 */
function blockingError(query: { error: unknown; data: unknown }): Error | null {
  if (!query.error) return null;
  if (query.data !== undefined && query.error instanceof TypeError) return null;
  return query.error instanceof Error ? query.error : new Error("Failed to load app state");
}

/** An admin requires two-step sign-in and this person has not turned it on yet. */
function TwoStepRequiredPage() {
  const signOut = useSignOut();
  return (
    <div className="mx-auto max-w-2xl py-10">
      <Card className="block space-y-6 p-6">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">Turn on two-step sign-in to continue</h1>
          <p className="text-sm text-muted-foreground">
            An admin of this GS Agentic Manager instance requires two-step sign-in for everyone. It takes about a
            minute with an authenticator app on your phone.
          </p>
        </div>
        <TwoStepSignInSection />
        <Button type="button" variant="outline" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
          Sign out
        </Button>
      </Card>
    </div>
  );
}

function NotAnsweringPage({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">
        <h1 className="text-xl font-semibold">GSAM is not answering</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This device may be offline, or the computer that runs GSAM may be asleep or restarting.
        </p>
        <Button type="button" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      </Card>
    </div>
  );
}

export function CloudAccessGate({ allowMembershipRequest = false }: { allowMembershipRequest?: boolean } = {}) {
  const location = useLocation();
  const queryClient = useQueryClient();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as
        | { deploymentMode?: "local_trusted" | "authenticated"; bootstrapStatus?: "ready" | "bootstrap_pending" }
        | undefined;
      return data?.deploymentMode === "authenticated" && data.bootstrapStatus === "bootstrap_pending"
        ? 2000
        : false;
    },
    refetchIntervalInBackground: true,
  });

  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const isBootstrapPending = isAuthenticatedMode && healthQuery.data?.bootstrapStatus === "bootstrap_pending";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
  });

  const twoStepQuery = useQuery({
    queryKey: queryKeys.auth.twoStep,
    queryFn: () => authApi.getTwoStepStatus(),
    enabled: isAuthenticatedMode && !isBootstrapPending && !!sessionQuery.data,
    retry: false,
  });
  // Until two-step sign-in is on, the server answers only sign-in and setup.
  const twoStepSetupRequired = Boolean(
    twoStepQuery.data?.required && twoStepQuery.data.available && !twoStepQuery.data.enabled,
  );

  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled:
      isAuthenticatedMode && !isBootstrapPending && !!sessionQuery.data && twoStepQuery.isFetched && !twoStepSetupRequired,
    retry: false,
  });
  const claimMutation = useMutation({
    mutationFn: () => accessApi.claimBootstrapAdmin(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
    },
  });

  if (
    healthQuery.isLoading ||
    (isAuthenticatedMode && sessionQuery.isLoading) ||
    (isAuthenticatedMode && !isBootstrapPending && !!sessionQuery.data && twoStepQuery.isLoading) ||
    (isAuthenticatedMode && !isBootstrapPending && !!sessionQuery.data && boardAccessQuery.isLoading)
  ) {
    return <BrandLoading />;
  }

  if (twoStepSetupRequired) {
    return <TwoStepRequiredPage />;
  }

  const gateError = blockingError(healthQuery) ?? blockingError(boardAccessQuery);
  if (gateError) {
    if (gateError instanceof TypeError) {
      return (
        <NotAnsweringPage
          onRetry={() => {
            void healthQuery.refetch();
            if (boardAccessQuery.error) void boardAccessQuery.refetch();
          }}
        />
      );
    }
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{gateError.message}</div>
    );
  }

  if (isBootstrapPending) {
    const health = healthQuery.data;
    if (!health) {
      return <BrandLoading />;
    }
    const claimError = claimMutation.error instanceof ApiError
      ? { status: claimMutation.error.status, message: claimMutation.error.message }
      : claimMutation.error instanceof Error
        ? { message: claimMutation.error.message }
        : null;
    return (
      <BootstrapPendingPage
        claimAvailable={health.deploymentExposure === "private"}
        hasActiveInvite={health.bootstrapInviteActive}
        session={sessionQuery.data}
        claimState={claimMutation.isSuccess ? "success" : claimMutation.isPending ? "claiming" : "idle"}
        claimError={claimError}
        onClaim={() => claimMutation.mutate()}
      />
    );
  }

  if (isAuthenticatedMode && !sessionQuery.data) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }

  // Private invitation pages may let signed-in nonmembers request access.
  // Their token APIs still enforce membership before granting any authority.
  if (
    !allowMembershipRequest &&
    isAuthenticatedMode &&
    sessionQuery.data &&
    !boardAccessQuery.data?.isInstanceAdmin &&
    (boardAccessQuery.data?.companyIds.length ?? 0) === 0
  ) {
    return <NoBoardAccessPage />;
  }

  return <Outlet />;
}
