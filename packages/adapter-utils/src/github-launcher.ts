/** Standalone source is staged unchanged on local, SSH, and sandbox runtimes. No secrets in files. */
export function githubLauncherSource(): string {
  return String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const directory = path.dirname(fs.realpathSync(process.argv[1]));
const program = path.basename(process.argv[1]);
const originalPath = (process.env.PATH || '').split(path.delimiter).filter(p => {
  try { return fs.realpathSync(p) !== directory; } catch { return true; }
});
const findExecutable = (name) => originalPath.map(p => path.join(p, name)).find(p => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
});
const executable = findExecutable(program);
if (!['git', 'gh'].includes(program) || !executable) {
  process.stderr.write('GS Agentic Manager: requested GitHub command is not installed.\n');
  process.exit(127);
}
// GRE-6168: the managed token reaches every repository its owner has. The
// broker sends which repositories a run may write to; refuse anything else
// before the real command runs. The credential helper is scoped the same way.
function normalizeRepo(value) {
  return String(value || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^(www\.)?github\.com\//, '')
    .replace(/\/+$/, '').replace(/\.git$/, '');
}
function githubRepo(url) {
  const m = /^(?:https?|git|ssh|git\+ssh|ssh\+git):\/\/(?:[^@\/]*@)?(?:www\.)?github\.com(?::\d+)?\/([^\/]+\/[^\/]+?)(?:\.git)?\/*$/i.exec(url)
    || /^(?:[^@\/:]+@)?(?:www\.)?github\.com:\/?([^\/]+\/[^\/]+?)(?:\.git)?\/*$/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}
function isLocalUrl(url) {
  if (/^file:\/\//i.test(url)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false;
  return !/^[^\/]*:/.test(url); // scp-style host:path is a network remote
}
function makeGitQuery(env, globalArgs) {
  return (args) => {
    const git = program === 'git' ? executable : findExecutable('git');
    if (!git) return null;
    const r = spawnSync(git, globalArgs.concat(args),
      { env: Object.assign({}, env, { GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' }), encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout).trim() : null;
  };
}
const GIT_GLOBAL_VALUE_OPTIONS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--super-prefix'];
const GIT_BUILTINS = new Set(['add', 'am', 'apply', 'bisect', 'blame', 'branch', 'cat-file', 'checkout', 'cherry-pick', 'clean', 'clone',
  'commit', 'config', 'describe', 'diff', 'fetch', 'for-each-ref', 'grep', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge',
  'merge-base', 'mv', 'notes', 'pull', 'rebase', 'reflog', 'remote', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm',
  'shortlog', 'show', 'show-ref', 'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref',
  'var', 'version', 'worktree', 'help', 'gc', 'hash-object', 'format-patch', 'range-diff', 'sparse-checkout', 'credential']);
function splitGit(args) {
  const globalArgs = [];
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (GIT_GLOBAL_VALUE_OPTIONS.includes(args[i])) { if (args[i + 1] !== undefined) globalArgs.push(args[i], args[i + 1]); i += 2; continue; }
    if (/^--(git-dir|work-tree|namespace|config-env|attr-source)=/.test(args[i]) || args[i] === '--bare') globalArgs.push(args[i]);
    i++;
  }
  return { globalArgs, command: args[i], rest: args.slice(i + 1) };
}
function checkGit(args, policy, env, depth) {
  const { globalArgs, command, rest } = splitGit(args);
  if (!command) return null;
  if (command === 'send-pack' || command === 'http-push') return 'git ' + command + ' is not allowed; use git push';
  const git = makeGitQuery(env, globalArgs);
  if (command !== 'push') {
    if (GIT_BUILTINS.has(command) || depth > 4) return null;
    const alias = git(['config', '--get', 'alias.' + command]);
    if (!alias) return null;
    if (alias.startsWith('!')) return /push|send-pack/.test(alias) ? 'the git alias "' + command + '" runs a push; run git push directly' : null;
    return checkGit(globalArgs.concat(alias.split(/\s+/).filter(Boolean), rest), policy, env, depth + 1);
  }
  let remote = null, tagsAll = null, deleting = false;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') { positional.push(...rest.slice(i + 1)); break; }
    if (a.startsWith('--repo=')) { remote = a.slice(7); continue; }
    if (a === '--repo') { remote = rest[++i]; continue; }
    if (['--receive-pack', '--exec', '--push-option'].includes(a)) { i++; continue; }
    if (a === '--tags' || a === '--follow-tags' || a === '--mirror') { tagsAll = a; continue; }
    if (a === '--delete') { deleting = true; continue; }
    if (a === '--recurse-submodules=on-demand') return 'git push --recurse-submodules=on-demand pushes other repositories';
    if (/^-o./.test(a)) continue;
    if (/^-[^-]/.test(a)) { if (a.includes('d')) deleting = true; if (a.endsWith('o')) i++; continue; }
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  if (positional.length) remote = positional.shift();
  const refspecs = positional;
  if (!remote) {
    const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    remote = (branch && git(['config', '--get', 'branch.' + branch + '.pushRemote']))
      || git(['config', '--get', 'remote.pushDefault'])
      || (branch && git(['config', '--get', 'branch.' + branch + '.remote'])) || 'origin';
  }
  const configured = git(['remote', 'get-url', '--push', '--all', remote]);
  const urls = configured !== null ? configured.split('\n').filter(Boolean) : [git(['ls-remote', '--get-url', remote]) || remote];
  for (const url of urls) {
    const repo = githubRepo(url);
    if (repo ? !policy.repositories.includes(repo) : !isLocalUrl(url)) {
      return 'git push to ' + (repo || 'a non-GitHub remote') + ' is not allowed';
    }
  }
  if (!policy.allowTagPush) {
    if (tagsAll) return 'git push ' + tagsAll + ' pushes tags; only release agents push tags';
    if (configured !== null && git(['config', '--get', 'remote.' + remote + '.mirror']) === 'true') return 'remote ' + remote + ' is a mirror; only release agents push tags';
    const specs = refspecs.length || configured === null ? refspecs : (git(['config', '--get-all', 'remote.' + remote + '.push']) || '').split('\n').filter(Boolean);
    for (let i = 0; i < specs.length; i++) {
      if (specs[i] === 'tag') return 'git push tag pushes a tag; only release agents push tags';
      const spec = specs[i].replace(/^\+/, '');
      const colon = spec.indexOf(':');
      const src = colon < 0 ? spec : spec.slice(0, colon), dst = colon < 0 ? '' : spec.slice(colon + 1);
      if (src.startsWith('refs/tags/') || dst.startsWith('refs/tags/')) return 'pushing ' + spec + ' pushes a tag; only release agents push tags';
      for (const name of [src, colon < 0 && deleting ? spec : ''].filter(Boolean)) {
        if (name.startsWith('refs/') || /[*?\[]/.test(name)) continue;
        if (git(['show-ref', '--verify', '--quiet', 'refs/tags/' + name]) !== null && git(['show-ref', '--verify', '--quiet', 'refs/heads/' + name]) === null) {
          return 'pushing ' + name + ' pushes a tag; only release agents push tags';
        }
      }
    }
  }
  return null;
}
const GH_READ_VERBS = new Set(['view', 'list', 'status', 'diff', 'checks', 'download', 'watch', 'clone', 'checkout', 'search', 'browse']);
const GH_API_VALUE_OPTIONS = ['-X', '--method', '-f', '-F', '--field', '--raw-field', '-H', '--header', '--input', '-q', '--jq', '-t', '--template', '--cache', '--hostname', '-p', '--preview'];
const GRAPHQL_REPO_MUTATIONS = /\b(createRepository|cloneTemplateRepository|updateRepository|archiveRepository|unarchiveRepository|createRef|updateRefs?|deleteRef|createCommitOnBranch|createRelease|updateRelease|deleteRelease)\b/;
function checkGhApi(args, policy, env) {
  let method = null, sendsBody = false, endpoint = null;
  const bodies = [];
  for (let i = 0; i < args.length; i++) {
    let a = args[i], value = null;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq > 0) { value = a.slice(eq + 1); a = a.slice(0, eq); }
    else if (/^-[XfFHqtp]./.test(a)) { value = a.slice(2); a = a.slice(0, 2); }
    else if (GH_API_VALUE_OPTIONS.includes(a)) value = args[++i];
    else if (!a.startsWith('-')) { if (endpoint === null) endpoint = a; continue; }
    else continue;
    if (a === '-X' || a === '--method') method = String(value || '').toUpperCase();
    if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a)) {
      sendsBody = true;
      const text = a === '--input' ? '@' + value : String(value || '').replace(/^[^=]*=/, '');
      if (text.startsWith('@')) {
        try { bodies.push(fs.readFileSync(text.slice(1), 'utf8')); } catch { bodies.push(null); }
      } else bodies.push(text);
    }
  }
  method = method || (sendsBody ? 'POST' : 'GET');
  if (method === 'GET' || method === 'HEAD') return null;
  if (endpoint === 'graphql') {
    if (bodies.some(body => body === null)) return 'gh api graphql with a body GSAM cannot read is not allowed';
    return bodies.some(body => GRAPHQL_REPO_MUTATIONS.test(body)) ? 'this GraphQL mutation changes repositories, refs or releases' : null;
  }
  let target = String(endpoint || '').replace(/^https?:\/\/api\.github\.com/i, '').replace(/^\/+/, '');
  if (target.includes('{owner}') || target.includes('{repo}')) {
    const origin = githubRepo(makeGitQuery(env, [])(['remote', 'get-url', 'origin']) || '');
    if (!origin) return 'gh api could not resolve {owner}/{repo} to an allowed repository';
    const [owner, name] = origin.split('/');
    target = target.split('{owner}').join(owner).split('{repo}').join(name);
  }
  const m = /^repos\/([^\/]+\/[^\/?#]+)/i.exec(target);
  if (m && policy.repositories.includes(normalizeRepo(m[1]))) return null;
  return 'gh api ' + method + ' ' + (endpoint || '') + ' writes outside the allowed repositories';
}
function checkGh(args, policy, env) {
  const words = [];
  let repoFlag = null, visibility = false, showToken = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-R' || a === '--repo') { repoFlag = args[++i] || ''; continue; }
    if (a.startsWith('--repo=')) { repoFlag = a.slice(7); continue; }
    if (/^-R./.test(a)) { repoFlag = a.slice(2); continue; }
    if (a === '--visibility' || a.startsWith('--visibility=')) visibility = true;
    if (a === '-t' || a === '--show-token') showToken = true;
    if (!a.startsWith('-')) words.push(a);
  }
  const [group, verb] = words;
  const allowed = (repo) => policy.repositories.includes(normalizeRepo(repo));
  const named = words.slice(2).filter(w => /^[\w.-]+\/[\w.-]+$/.test(normalizeRepo(w)));
  if (group === 'api') return checkGhApi(args.slice(args.indexOf('api') + 1), policy, env);
  if (group === 'auth' && (verb === 'token' || (verb === 'status' && showToken))) return 'gh auth ' + verb + ' prints the GitHub token';
  if (group === 'gist') return 'gh gist publishes outside the allowed repositories';
  if (group === 'repo') {
    if (['create', 'fork', 'delete', 'rename', 'archive', 'unarchive', 'transfer'].includes(verb)) return 'gh repo ' + verb + ' is not allowed for agents';
    if (verb === 'deploy-key' && words[2] !== 'list') return 'gh repo deploy-key changes repository access';
    if (verb === 'edit' && visibility) return 'gh repo edit --visibility is not allowed for agents';
  }
  if (group === 'release' && !GH_READ_VERBS.has(verb) && !policy.allowTagPush) return 'gh release ' + verb + ' creates or changes releases; only release agents do that';
  if ((group === 'secret' || group === 'variable') && !GH_READ_VERBS.has(verb)) return 'gh ' + group + ' ' + verb + ' changes repository settings';
  if (!GH_READ_VERBS.has(verb) && !GH_READ_VERBS.has(group)) {
    const targets = (repoFlag !== null ? [repoFlag] : []).concat(group === 'repo' ? named : []);
    const outside = targets.find(t => !allowed(t));
    if (outside !== undefined) return 'gh ' + group + ' ' + (verb || '') + ' on ' + (normalizeRepo(outside) || 'that repository') + ' is not allowed';
  }
  return null;
}
async function main() {
  let env = { ...process.env };
  let policy = null;
  const diagnostic = (code, detail) => process.stderr.write('GS Agentic Manager: GitHub ' + code + (detail ? ' (' + detail + ')' : '') + '; continuing without managed credentials.\n');
  const configRoot = env.GH_CONFIG_DIR || os.tmpdir();
  // A missing/unwritable scratch directory must not break local Git. The
  // fallback deliberately cannot load the host's gh authentication files.
  let configDirectory = path.join(directory, 'unavailable-gh-config');
  let configReady = false;
  try {
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    configDirectory = fs.mkdtempSync(path.join(configRoot, 'paperclip-github-operation-'));
    fs.chmodSync(configDirectory, 0o700);
    configReady = true;
    process.once('exit', () => { try { fs.rmSync(configDirectory, { recursive: true, force: true }); } catch {} });
  } catch { diagnostic('configuration_directory_unavailable'); }
  {
    for (const key of Object.keys(env)) {
      if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GSAM_GIT_TOKEN|GSAM_GIT_REPOSITORIES|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_CONFIG_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*)$/.test(key)) delete env[key];
    }
    Object.assign(env, {
      GH_CONFIG_DIR: configDirectory, SSH_AUTH_SOCK: '',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      // The inherited identity was deleted above. Empty identity env values
      // override even explicit repository/command config and break local commits.
      // Require configured identity instead of guessing the OS user's details.
      GIT_CONFIG_COUNT: '5', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'git@github.com:',
      GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
      GIT_CONFIG_KEY_3: 'core.askPass', GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'user.useConfigOnly', GIT_CONFIG_VALUE_4: 'true',
    });
    const base = env.GSAM_GITHUB_BROKER_URL || env.GSAM_API_URL;
    try {
    let response;
    if (base && env.GSAM_GITHUB_BROKER_TOKEN) {
      const url = base.replace(/\/+$/, '').replace(/\/api$/, '') + '/runtime-tools/github/credentials';
      for (let attempt = 0; attempt < 30; attempt++) {
        response = await fetch(url, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { authorization: 'Bearer ' + (env.GSAM_GITHUB_BRIDGE_TOKEN || env.GSAM_API_KEY || env.GSAM_GITHUB_BROKER_TOKEN),
            'x-paperclip-github-capability': env.GSAM_GITHUB_BROKER_TOKEN, 'content-type': 'application/json' },
          body: '{}',
        });
        if (response.status !== 409) break;
        await response.arrayBuffer();
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (response.status === 401 || response.status === 403) {
        // Say why. A refusal body is fixed server text; never echo anything else.
        let detail = '';
        try {
          const refusal = await response.json();
          if (refusal && refusal.code === 'run_not_active') {
            detail = 'this run has already ended, so GS Agentic Manager no longer issues GitHub credentials for it';
          } else if (refusal && typeof refusal.error === 'string') {
            detail = refusal.error.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);
          }
        } catch {}
        diagnostic('capability_rejected', detail);
      } else if (!response.ok) {
        diagnostic('broker_response_unavailable');
      } else {
      const result = await response.json();
      if (result.status === 'unavailable' || result.status === 'absent') {
        const reason = typeof result.reason === 'string'
          ? result.reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)
          : 'Check the GitHub connection in GS Agentic Manager';
        process.stderr.write('GS Agentic Manager: GitHub access unavailable: ' + reason + '. Continuing without GitHub credentials.\n');
      }
      if (result.status === 'available' && configReady) {
        // A credential without a policy fails closed: no repository, no tags.
        const given = result.policy && typeof result.policy === 'object' ? result.policy : {};
        policy = {
          repositories: Array.isArray(given.repositories) ? given.repositories.filter(r => typeof r === 'string').map(normalizeRepo) : [],
          allowTagPush: given.allowTagPush === true,
        };
        for (const [key, value] of Object.entries(result.env || {})) {
          if (/^(GH_TOKEN|GITHUB_TOKEN|GSAM_GIT_TOKEN|GSAM_GIT_REPOSITORIES|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/.test(key) && typeof value === 'string') env[key] = value;
        }
      }
      }
    } else { diagnostic('capability_missing'); }
    } catch { diagnostic('broker_transport_unavailable'); }
  }
  // Only this invocation and its children inherit the captured credential.
  // Its Git children use the real binary, so steering cannot split a gh operation.
  env.PATH = originalPath.join(path.delimiter);
  // Nested shell aliases must not reload the parent launcher profile and
  // recapture a newer identity. All ordinary descendants stay in this operation.
  env.ZDOTDIR = configDirectory;
  env.BASH_ENV = '/dev/null';
  env.GIT_SSH_COMMAND = 'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes';
  if (policy) {
    const args = process.argv.slice(2);
    const refusal = program === 'git' ? checkGit(args, policy, env, 0) : checkGh(args, policy, env);
    if (refusal) {
      process.stderr.write('GS Agentic Manager: refused: ' + refusal + '. Agents may write only to: '
        + (policy.repositories.join(', ') || 'no repository') + '. Ask Everest if a task needs more (GRE-6168).\n');
      process.exitCode = 1;
      return;
    }
    if (!policy.allowTagPush) {
      // A repository's push.followTags must not push tags behind the check.
      const count = Number(env.GIT_CONFIG_COUNT) || 0;
      env['GIT_CONFIG_KEY_' + count] = 'push.followTags';
      env['GIT_CONFIG_VALUE_' + count] = 'false';
      env.GIT_CONFIG_COUNT = String(count + 1);
    }
  }
  const child = spawn(executable, process.argv.slice(2), { env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.once('error', () => { process.stderr.write('GS Agentic Manager: GitHub command could not start.\n'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code === null ? 128 : code; });
}
main().catch(() => { process.stderr.write('GS Agentic Manager: GitHub launcher_setup_failed.\n'); process.exitCode = 1; });
`;
}

/** Override inherited credentials even when adapters merge the host environment later. */
export function githubBrokerEnvironment(input: Record<string, unknown>, broker: { url: string; token: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (typeof value === "string") env[key] = value;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GSAM_GIT_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_COUNT", "GSAM_GITHUB_OPERATION_ACTIVE"]) env[key] = "";
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) env[key] = "";
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  env.GIT_SSH_COMMAND = "ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes";
  env.SSH_AUTH_SOCK = "";
  env.GSAM_GITHUB_BROKER_URL = broker.url;
  env.GSAM_GITHUB_BROKER_TOKEN = broker.token;
  return env;
}
