export const DEV_SERVER_HOST_ENV: "GSAM_DEV_HOST";
export const DEFAULT_DEV_SERVER_HOST: "127.0.0.1";
export function resolveDevServerHost(value: string | undefined): string;
export function isLoopbackHost(host: string): boolean;
export function defaultListenHost<T extends object>(
  server: T,
  host: string,
  onDefaultHost?: (host: string) => void,
): T;
