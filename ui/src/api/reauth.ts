import { api } from "./client";

// Login mode (GRE-133): release, rollback and promote ask for the password
// again. The server answers `403 { code: "reauth_required" }`; a password
// buys a one-use token (5 minutes) sent back as `X-GSAM-Reauth`.

export type ReauthAction = "release" | "rollback" | "promote";

export const REAUTH_HEADER = "X-GSAM-Reauth";

export const reauthApi = {
  confirm: (action: ReauthAction, password: string) =>
    api.post<{ token: string; expiresAt: string }>("/reauth", { action, password }),
};
