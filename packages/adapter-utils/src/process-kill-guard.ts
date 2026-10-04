import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellQuote } from "./ssh.js";

/**
 * What an agent run's `pkill` and `killall` must never signal. Agents run as
 * the same OS user as the live server, so a broad pattern can stop live: on
 * 4 Oct 2026 `pkill -f "dev-runner.ts dev"` from an agent sandbox stopped live
 * for 8.5 hours.
 */
export type ProcessKillGuard = {
  /** Absolute directories of the live install and its data. */
  protectedPaths: readonly string[];
  /** The live server's PID. It and the processes that started it are protected. */
  serverPid: number;
  /**
   * The run's own workspace. A path inside it never counts as live, so an
   * agent whose workspace sits under the data directory can still stop what it
   * started there. Ignored unless it lies strictly inside a protected path.
   */
  ownWorkspace?: string | null;
};

export const PROCESS_KILL_GUARD_COMMANDS = ["pkill", "killall"] as const;

/** The wrappers rely on procps/psmisc (Linux) or the BSD tools (macOS). */
export function processKillGuardSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux" || platform === "darwin";
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathForms(value: string): string[] {
  if (!path.isAbsolute(value) || /[\n\0]/.test(value)) return [];
  const resolved = path.resolve(value);
  try {
    const real = fs.realpathSync.native(resolved);
    return real === resolved ? [resolved] : [resolved, real];
  } catch {
    return [resolved];
  }
}

/** Protected and exempt directories as the wrapper embeds them. */
export function processKillGuardPaths(guard: ProcessKillGuard, homeDir = os.homedir()) {
  // A root or home directory would protect nearly every process the agent
  // starts, so it is never used as a marker of live.
  const protectedPaths = [...new Set(guard.protectedPaths.flatMap(pathForms))]
    .filter((candidate) => candidate !== path.parse(candidate).root && !isInside(candidate, homeDir));
  const exemptPaths = [...new Set(guard.ownWorkspace ? pathForms(guard.ownWorkspace) : [])]
    .filter((own) => protectedPaths.some((guarded) => own !== guarded && isInside(guarded, own)))
    .filter((own) => !protectedPaths.some((guarded) => isInside(own, guarded)));
  return { protectedPaths, exemptPaths };
}

// Shell parameter expansions are written ${S}{name} so they survive this
// TypeScript template literal.
const S = "$";

const GUARD_BODY = String.raw`set -f
export GUARD_PROTECTED GUARD_EXEMPT
guard_name=$(basename "$0")
guard_self=$(cd -P "$(dirname "$0")" 2>/dev/null && pwd -P)

guard_say() { printf '%s: %s\n' "$guard_name" "$*" >&2; }
guard_usage() {
  guard_say "$*"
  exit 2
}
guard_refuse() {
  guard_say "the GSAM process guard cannot safely translate '$1', so nothing was signalled."
  guard_say "Use the plain options, or stop the process by the PID you recorded when you started it."
  exit 2
}

# The real command: the first one on PATH outside this directory that is not
# another copy of this guard.
guard_find() {
  guard_ifs=$IFS
  IFS=:
  for guard_dir in $PATH; do
    IFS=$guard_ifs
    [ -n "$guard_dir" ] || guard_dir=.
    [ -f "$guard_dir/$1" ] && [ -x "$guard_dir/$1" ] || continue
    [ "$(cd -P "$guard_dir" 2>/dev/null && pwd -P)" != "$guard_self" ] || continue
    grep -q 'GSAM process guard' "$guard_dir/$1" 2>/dev/null && continue
    printf '%s\n' "$guard_dir/$1"
    return 0
  done
  IFS=$guard_ifs
  return 1
}

# Prints $1 as a signal for "kill -s", or fails when it is not a signal.
guard_signal() {
  guard_s=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')
  case $guard_s in SIG?*) guard_s=$(printf '%s' "$guard_s" | cut -c4-) ;; esac
  case $guard_s in
    [0-9] | [0-9][0-9]) echo "$guard_s" ;;
    EXIT | NULL) echo 0 ;;
    CLD) echo CHLD ;;
    POLL) echo IO ;;
    IOT) echo ABRT ;;
    HUP | INT | QUIT | ILL | TRAP | ABRT | BUS | FPE | KILL | USR1 | SEGV | USR2 | PIPE | ALRM | TERM | \
      STKFLT | CHLD | CONT | STOP | TSTP | TTIN | TTOU | URG | XCPU | XFSZ | VTALRM | PROF | WINCH | IO | \
      PWR | SYS | EMT | INFO | RTMIN | RTMAX | RTMIN+[0-9] | RTMIN+[0-9][0-9] | RTMAX-[0-9] | RTMAX-[0-9][0-9])
      echo "$guard_s" ;;
    *) return 1 ;;
  esac
}

guard_alive() { [ -d "/proc/$1" ] || ps -p "$1" >/dev/null 2>&1; }

guard_ppid() {
  if [ -r "/proc/$1/stat" ]; then
    sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f2
  else
    ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '
  fi
}

guard_state() {
  if [ -r "/proc/$1/stat" ]; then
    sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -c1
  else
    ps -o state= -p "$1" 2>/dev/null
  fi
}

guard_comm() {
  if [ -r "/proc/$1/comm" ]; then
    cat "/proc/$1/comm" 2>/dev/null
  else
    basename "$(ps -o comm= -p "$1" 2>/dev/null)"
  fi
}

# The live server and every process above it (its runner, pnpm, the shell
# that started it). Walked once, when the first match is checked.
guard_tree=
guard_tree_ready=
guard_server_tree() {
  [ -z "$guard_tree_ready" ] || return 0
  guard_tree_ready=1
  guard_p=$GUARD_SERVER_PID
  guard_i=0
  while [ "$guard_i" -lt 64 ]; do
    case $guard_p in '' | 0 | 1 | *[!0-9]*) break ;; esac
    guard_alive "$guard_p" || break
    guard_tree="$guard_tree $guard_p"
    guard_p=$(guard_ppid "$guard_p")
    guard_i=$((guard_i + 1))
  done
}

# Succeeds when live owns process $1: the server or a process above it, or a
# process whose arguments, executable or working directory lie in a protected
# directory (outside this run's own workspace). A running process that cannot
# be checked counts as live.
guard_is_live() {
  guard_server_tree
  case " $guard_tree " in *" $1 "*) return 0 ;; esac
  if [ -r "/proc/$1/cmdline" ]; then
    guard_info=$({ tr '\000' '\n' <"/proc/$1/cmdline"; echo; readlink "/proc/$1/exe"; readlink "/proc/$1/cwd"; } 2>/dev/null)
  else
    guard_info=$({ ps -ww -o args= -p "$1"; ps -o comm= -p "$1"; } 2>/dev/null)
  fi
  if [ -z "$guard_info" ]; then
    # A zombie has nothing left to check and is harmless to signal.
    case $(guard_state "$1") in Z*) return 1 ;; esac
    guard_alive "$1"
    return
  fi
  printf '%s\n' "$guard_info" | awk '
    function edge(text, at, size, next_char) {
      next_char = substr(text, at + size, 1)
      return next_char == "" || next_char !~ /[A-Za-z0-9._-]/
    }
    BEGIN {
      guarded = split(ENVIRON["GUARD_PROTECTED"], protected_dir, "\n")
      own = split(ENVIRON["GUARD_EXEMPT"], own_dir, "\n")
    }
    {
      for (i = 1; i <= guarded; i++) {
        if (protected_dir[i] == "") continue
        from = 1
        while ((at = index(substr($0, from), protected_dir[i])) > 0) {
          at += from - 1
          if (edge($0, at, length(protected_dir[i]))) {
            mine = 0
            for (j = 1; j <= own; j++)
              if (own_dir[j] != "" && substr($0, at, length(own_dir[j])) == own_dir[j] && edge($0, at, length(own_dir[j])))
                mine = 1
            if (!mine) { live = 1; exit }
          }
          from = at + 1
        }
      }
    }
    END { exit !live }'
  [ "$?" -ne 1 ]
}

guard_check_pids() {
  for guard_pid in $guard_pids; do
    case $guard_pid in *[!0-9]*)
      guard_say "unexpected output from pgrep, so nothing was signalled."
      exit 3 ;;
    esac
  done
}

# Signals each PID in $1 that live does not own and updates the counters.
guard_apply() {
  for guard_pid in $1; do
    [ "$guard_pid" != "$$" ] || continue
    [ "$(guard_ppid "$guard_pid")" != "$$" ] || continue
    case " $guard_done " in *" $guard_pid "*)
      guard_hit=1
      continue ;;
    esac
    guard_matched=$((guard_matched + 1))
    if guard_is_live "$guard_pid"; then
      guard_live=$((guard_live + 1))
      continue
    fi
    guard_label=$(guard_comm "$guard_pid")
    if kill -s "$guard_sig" "$guard_pid" 2>/dev/null; then
      guard_done="$guard_done $guard_pid"
      guard_killed=$((guard_killed + 1))
      guard_hit=1
      [ -z "$guard_echo" ] || printf '%s killed (pid %s)\n' "$guard_label" "$guard_pid"
      [ -z "$guard_verbose" ] || printf 'Killed %s(%s) with signal %s\n' "$guard_label" "$guard_pid" "$guard_sig" >&2
    elif guard_alive "$guard_pid"; then
      [ -n "$guard_quiet" ] || guard_say "killing pid $guard_pid failed"
    fi
  done
}

guard_report() {
  [ "$guard_live" -gt 0 ] || return 0
  guard_say "GSAM guard: left $guard_live matching process(es) alone. They belong to the live GS Agentic Manager (its install or data directory, or the server and the processes that started it), or could not be checked."
  guard_say "To stop your own sandbox, run \"pnpm dev:stop --data-dir <the --data-dir you started it with>\" from your worktree root, or kill the PID you recorded when you started it."
}

guard_pkill() {
  guard_sig_dash=
  guard_sig_long=
  guard_end=
  guard_first=1
  guard_n=$#
  # Rotate the arguments: each original is shifted off the front and what
  # pgrep should see is appended to the back.
  while [ "$guard_n" -gt 0 ]; do
    guard_a=$1
    shift
    guard_n=$((guard_n - 1))
    if [ -n "$guard_end" ]; then
      set -- "$@" "$guard_a"
      continue
    fi
    guard_was_first=$guard_first
    guard_first=
    case $guard_a in
      --)
        guard_end=1
        set -- "$@" "$guard_a" ;;
      --*)
        [ "$GUARD_FLAVOUR" = gnu ] || guard_refuse "$guard_a"
        case $guard_a in
          --signal=*) guard_sig_long=$(printf '%s' "$guard_a" | cut -c10-) ;;
          --signal)
            [ "$guard_n" -gt 0 ] || guard_usage "option '--signal' requires an argument"
            guard_sig_long=$1
            shift
            guard_n=$((guard_n - 1)) ;;
          --echo) guard_echo=1 ;;
          --count) guard_count=1 ;;
          --help | --version) exec "$guard_real" "$guard_a" ;;
          --full | --ignore-case | --newest | --oldest | --exact | --logpidfile | --ignore-ancestors | --require-handler)
            set -- "$@" "$guard_a" ;;
          --pgroup=* | --group=* | --older=* | --parent=* | --session=* | --terminal=* | --euid=* | --uid=* | \
            --pidfile=* | --runstates=* | --cgroup=* | --ns=* | --nslist=*)
            set -- "$@" "$guard_a" ;;
          --pgroup | --group | --older | --parent | --session | --terminal | --euid | --uid | \
            --pidfile | --runstates | --cgroup | --ns | --nslist)
            [ "$guard_n" -gt 0 ] || guard_usage "option '$guard_a' requires an argument"
            set -- "$@" "$guard_a" "$1"
            shift
            guard_n=$((guard_n - 1)) ;;
          *) guard_refuse "$guard_a" ;;
        esac ;;
      -?*)
        # procps takes the first -SIG anywhere; BSD only as the first argument.
        if [ -z "$guard_sig_dash" ] && { [ "$GUARD_FLAVOUR" = gnu ] || [ -n "$guard_was_first" ]; } &&
          guard_s=$(guard_signal "${S}{guard_a#-}"); then
          guard_sig_dash=$guard_s
          continue
        fi
        guard_rest=${S}{guard_a#-}
        guard_keep=-
        while [ -n "$guard_rest" ]; do
          guard_c=${S}{guard_rest%"${S}{guard_rest#?}"}
          guard_rest=${S}{guard_rest#?}
          case $GUARD_PKILL_FLAGS in *"$guard_c"*)
            guard_keep=$guard_keep$guard_c
            continue ;;
          esac
          case $GUARD_PKILL_VALUES in *"$guard_c"*)
            if [ -n "$guard_rest" ]; then
              set -- "$@" "$guard_keep$guard_c$guard_rest"
            else
              [ "$guard_n" -gt 0 ] || guard_usage "option requires an argument -- '$guard_c'"
              set -- "$@" "$guard_keep$guard_c" "$1"
              shift
              guard_n=$((guard_n - 1))
            fi
            guard_keep=
            guard_rest=
            break ;;
          esac
          case $GUARD_FLAVOUR$guard_c in
            "$GUARD_FLAVOUR$GUARD_PKILL_ECHO") guard_echo=1 ;;
            "$GUARD_FLAVOUR$GUARD_PKILL_COUNT") guard_count=1 ;;
            gnuh | gnuV) exec "$guard_real" "-$guard_c" ;;
            *) guard_refuse "-$guard_c" ;;
          esac
        done
        [ "$guard_keep" = - ] || [ -z "$guard_keep" ] || set -- "$@" "$guard_keep" ;;
      *) set -- "$@" "$guard_a" ;;
    esac
  done
  guard_sig=TERM
  if [ -n "$guard_sig_long" ]; then
    guard_sig=$(guard_signal "$guard_sig_long") || guard_usage "unknown signal: $guard_sig_long"
  elif [ -n "$guard_sig_dash" ]; then
    guard_sig=$guard_sig_dash
  fi
  guard_pids=$("$guard_pgrep" "$@")
  guard_status=$?
  [ "$guard_status" -le 1 ] || exit "$guard_status"
  guard_check_pids
  guard_apply "$guard_pids"
  [ -z "$guard_count" ] || echo "$((guard_matched - guard_live))"
  guard_report
  [ "$guard_killed" -eq 0 ] || exit 0
  exit 1
}

guard_killall() {
  if [ "$#" -eq 1 ]; then
    case $GUARD_FLAVOUR:$1 in *:-l | gnu:--list | gnu:-V | gnu:--version | gnu:--help) exec "$guard_real" "$1" ;; esac
  fi
  guard_sig=TERM
  guard_user=
  guard_regex=
  guard_exact=
  guard_icase=
  guard_end=
  guard_n=$#
  while [ "$guard_n" -gt 0 ]; do
    guard_a=$1
    shift
    guard_n=$((guard_n - 1))
    if [ -n "$guard_end" ]; then
      set -- "$@" "$guard_a"
      continue
    fi
    case $GUARD_FLAVOUR:$guard_a in
      *:--) guard_end=1 ;;
      gnu:-s | gnu:--signal | *:-u | gnu:--user)
        [ "$guard_n" -gt 0 ] || guard_usage "option '$guard_a' requires an argument"
        case $guard_a in
          -u | --user) guard_user=$1 ;;
          *) guard_sig=$(guard_signal "$1") || guard_usage "unknown signal: $1" ;;
        esac
        shift
        guard_n=$((guard_n - 1)) ;;
      gnu:--signal=*) guard_sig=$(guard_signal "${S}{guard_a#--signal=}") || guard_usage "unknown signal: $guard_a" ;;
      gnu:--user=*) guard_user=${S}{guard_a#--user=} ;;
      gnu:-s?*) guard_sig=$(guard_signal "${S}{guard_a#-s}") || guard_refuse "$guard_a" ;;
      gnu:-e | gnu:--exact) guard_exact=1 ;;
      gnu:-I | gnu:--ignore-case) guard_icase=1 ;;
      gnu:-r | gnu:--regexp | bsd:-m) guard_regex=1 ;;
      *:-q | gnu:--quiet) guard_quiet=1 ;;
      *:-v | gnu:--verbose) guard_verbose=1 ;;
      gnu:-[0-9A-Z]* | bsd:-[0-9A-Za-z]*) guard_sig=$(guard_signal "${S}{guard_a#-}") || guard_refuse "$guard_a" ;;
      *:-?*) guard_refuse "$guard_a" ;;
      *) set -- "$@" "$guard_a" ;;
    esac
  done
  [ "$#" -gt 0 ] || [ -n "$guard_user" ] || exec "$guard_real"
  guard_popts=
  if [ -n "$guard_user" ]; then
    case $guard_user in *[!A-Za-z0-9._-]*) guard_refuse "-u $guard_user" ;; esac
    guard_popts="-u $guard_user"
  fi
  [ -z "$guard_icase" ] || guard_popts="$guard_popts -i"
  # Check every name before anything is signalled.
  for guard_a in "$@"; do
    case $guard_a in
      '') guard_usage "empty process name" ;;
      */*) guard_refuse "$guard_a (a path; give the process name)" ;;
    esac
    if [ -z "$guard_regex" ] && [ -n "$guard_exact" ] &&
      [ "$(printf '%s' "$guard_a" | wc -c)" -gt "$GUARD_COMM_MAX" ]; then
      guard_refuse "-e with a name longer than $GUARD_COMM_MAX characters"
    fi
  done
  guard_failed=
  if [ "$#" -eq 0 ]; then
    guard_pids=$("$guard_pgrep" $guard_popts)
    guard_status=$?
    [ "$guard_status" -le 1 ] || exit "$guard_status"
    guard_check_pids
    guard_hit=
    guard_apply "$guard_pids"
    [ -n "$guard_hit" ] || guard_failed=1
  fi
  for guard_a in "$@"; do
    if [ -n "$guard_regex" ]; then
      guard_pids=$("$guard_pgrep" $guard_popts -- "$guard_a")
    else
      # Names are matched exactly, as killall does (a long name by its first
      # characters, as the kernel stores it).
      guard_pat=$(printf '%s' "$guard_a" | cut -c1-"$GUARD_COMM_MAX" | sed 's/[][\\.*^$+?(){}|]/\\&/g')
      guard_pids=$("$guard_pgrep" $guard_popts -x -- "$guard_pat")
    fi
    guard_status=$?
    [ "$guard_status" -le 1 ] || exit "$guard_status"
    guard_check_pids
    guard_before=$guard_matched
    guard_hit=
    guard_apply "$guard_pids"
    if [ -z "$guard_hit" ]; then
      guard_failed=1
      [ "$guard_matched" -gt "$guard_before" ] || [ -n "$guard_quiet" ] || printf '%s: no process found\n' "$guard_a" >&2
    fi
  done
  guard_report
  [ -n "$guard_failed" ] || exit 0
  exit 1
}

guard_real=$(guard_find "$guard_name") || {
  guard_say "command not found"
  exit 127
}
guard_pgrep=$(guard_find pgrep) || {
  guard_say "the GSAM process guard needs pgrep to see what would be signalled, so nothing was signalled."
  exit 3
}
guard_echo=
guard_count=
guard_quiet=
guard_verbose=
guard_done=
guard_matched=0
guard_live=0
guard_killed=0
case $guard_name in
  pkill) guard_pkill "$@" ;;
  killall) guard_killall "$@" ;;
  *) guard_usage "unknown guard name" ;;
esac
`;

/** The wrapper script; one body serves both names (it dispatches on $0). */
export function processKillGuardScript(
  guard: ProcessKillGuard,
  platform: NodeJS.Platform = process.platform,
  homeDir = os.homedir(),
): string {
  const { protectedPaths, exemptPaths } = processKillGuardPaths(guard, homeDir);
  const serverPid = Number.isSafeInteger(guard.serverPid) && guard.serverPid > 1 ? guard.serverPid : 0;
  const gnu = platform !== "darwin";
  const header = [
    "#!/bin/sh",
    "# GSAM process guard, written by GS Agentic Manager for one agent run.",
    "# Agents run as the same user as the live server, so a broad pkill or",
    "# killall can stop live (4 Oct 2026: pkill -f \"dev-runner.ts dev\" stopped",
    "# it for 8.5 hours). This wrapper asks pgrep what the command would signal,",
    "# leaves live's processes alone and signals only the rest.",
    `GUARD_PROTECTED=${shellQuote(protectedPaths.join("\n"))}`,
    `GUARD_EXEMPT=${shellQuote(exemptPaths.join("\n"))}`,
    `GUARD_SERVER_PID=${serverPid}`,
    `GUARD_FLAVOUR=${gnu ? "gnu" : "bsd"}`,
    // pkill options pgrep shares (passed through), the ones that take a
    // value, and the pkill-only echo and count flags the wrapper reproduces.
    // Anything else (pgrep-only output options, -q/--queue, BSD -I) is refused.
    `GUARD_PKILL_FLAGS=${gnu ? "finoxLAH" : "afinovxL"}`,
    `GUARD_PKILL_VALUES=${gnu ? "FPOgsuUGtr" : "FGMNPUgtu"}`,
    `GUARD_PKILL_ECHO=${gnu ? "e" : "l"}`,
    `GUARD_PKILL_COUNT=${gnu ? "c" : "''"}`,
    `GUARD_COMM_MAX=${gnu ? 15 : 16}`,
  ];
  return `${header.join("\n")}\n${GUARD_BODY}`;
}

/** Wrapper files for the run's launcher directory, or none where unsupported. */
export function processKillGuardFiles(
  guard: ProcessKillGuard | null | undefined,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (!guard || !processKillGuardSupported(platform)) return {};
  const script = processKillGuardScript(guard, platform);
  return Object.fromEntries(PROCESS_KILL_GUARD_COMMANDS.map((name) => [name, script]));
}
