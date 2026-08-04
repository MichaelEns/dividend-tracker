/*
 * One-command deploy for the sync worker.
 *
 *   node setup.mjs
 *
 * Replaces this fiddly sequence, whose middle step - pasting a generated KV id
 * into wrangler.toml by hand - is the one people get wrong:
 *
 *   wrangler login
 *   wrangler kv namespace create TOKENS
 *   (edit wrangler.toml)
 *   wrangler secret put PLAID_CLIENT_ID          ... and five more
 *   wrangler deploy
 *
 * Credentials are read from .dev.vars (gitignored) when it exists, so the same
 * values used for local testing are the ones deployed. Anything missing is
 * prompted for. Nothing is ever written to a tracked file: secrets go to
 * Cloudflare via `wrangler secret put`, which stores them encrypted.
 *
 * Authentication happens one of two ways:
 *
 *   - `wrangler login`, an OAuth flow that redirects to http://localhost:8976.
 *     That listener only exists on the machine running this script, so the
 *     browser completing it must be this machine - a phone cannot.
 *   - CLOUDFLARE_API_TOKEN in the environment, which needs no callback and can
 *     therefore be created from any device, phone included:
 *       dash.cloudflare.com -> My Profile -> API Tokens -> Create Token
 *       -> "Edit Cloudflare Workers" template (covers Workers Scripts and KV).
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOML = path.join(HERE, 'wrangler.toml');
const DEV_VARS = path.join(HERE, '.dev.vars');

const SECRETS = [
  ['PLAID_CLIENT_ID', 'Plaid client_id', false],
  ['PLAID_SECRET', 'Plaid secret for the environment below', true],
  ['PLAID_ENV', 'Plaid environment (sandbox | production)', false],
  ['SNAPTRADE_CLIENT_ID', 'SnapTrade clientId (blank to skip)', false],
  ['SNAPTRADE_CONSUMER_KEY', 'SnapTrade consumerKey (blank to skip)', true],
  ['ALLOWED_ORIGINS', 'Site origin(s), comma separated', false],
  ['SYNC_PASSPHRASE', 'Sync passphrase (blank to generate one)', true],
];

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: HERE, shell: true, stdio: opts.stdin ? ['pipe', 'pipe', 'pipe'] : 'inherit' });
    let out = '';
    if (opts.stdin) {
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { out += d; });
      p.stdin.write(opts.stdin);
      p.stdin.end();
    }
    p.on('close', (code) => resolve({ code, out }));
  });
}

function capture(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: HERE, shell: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

function readDevVars() {
  if (!existsSync(DEV_VARS)) return {};
  const vars = {};
  for (const line of readFileSync(DEV_VARS, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q);

  console.log('\n=== divtracker sync worker setup ===\n');

  const who = await capture('npx', ['wrangler', 'whoami']);
  if (/not authenticated/i.test(who.out)) {
    if (process.env.CLOUDFLARE_API_TOKEN) {
      throw new Error('CLOUDFLARE_API_TOKEN is set but Cloudflare rejected it. '
        + 'Check it has the "Edit Cloudflare Workers" template permissions.');
    }
    console.log('Not logged in to Cloudflare.');
    console.log('This opens a browser on THIS machine (the OAuth callback is a');
    console.log('localhost listener, so a phone cannot complete it). To use a');
    console.log('phone instead, create an API token with the "Edit Cloudflare');
    console.log('Workers" template and re-run with CLOUDFLARE_API_TOKEN set.\n');
    const login = await run('npx', ['wrangler', 'login']);
    if (login.code !== 0) throw new Error('wrangler login failed');
  } else if (process.env.CLOUDFLARE_API_TOKEN) {
    console.log('Authenticated with CLOUDFLARE_API_TOKEN.\n');
  } else {
    const email = /([\w.+-]+@[\w.-]+)/.exec(who.out);
    console.log('Cloudflare account: ' + (email ? email[1] : 'authenticated') + '\n');
  }

  // KV holds the Plaid access_token. Without it every sync must re-run Plaid
  // Link, and a Trial plan only ever allows ten of those.
  let toml = readFileSync(TOML, 'utf8');
  if (/^\s*\[\[kv_namespaces\]\]/m.test(toml)) {
    console.log('KV namespace already bound in wrangler.toml.\n');
  } else {
    console.log('Creating the TOKENS KV namespace...');
    const kv = await capture('npx', ['wrangler', 'kv', 'namespace', 'create', 'TOKENS']);
    const id = /id\s*=\s*"([a-f0-9]{32})"/i.exec(kv.out) || /"?id"?\s*:\s*"([a-f0-9]{32})"/i.exec(kv.out);
    if (!id) {
      console.log(kv.out);
      throw new Error('Could not find the namespace id in the wrangler output. Bind it by hand.');
    }
    toml += `\n[[kv_namespaces]]\nbinding = "TOKENS"\nid = "${id[1]}"\n`;
    writeFileSync(TOML, toml);
    console.log(`Bound TOKENS -> ${id[1]} in wrangler.toml (safe to commit; it is not a secret).\n`);
  }

  const known = readDevVars();
  if (Object.keys(known).length) console.log('Found .dev.vars; press Enter to reuse each value.\n');

  const chosen = {};
  for (const [name, prompt, secret] of SECRETS) {
    const current = known[name] || '';
    const shown = current ? (secret ? ' [' + current.slice(0, 4) + '...]' : ' [' + current + ']') : '';
    const answer = (await ask(`${prompt}${shown}: `)).trim();
    let value = answer || current;
    if (name === 'SYNC_PASSPHRASE' && !value) {
      value = randomBytes(24).toString('base64url');
      console.log('  generated: ' + value + '\n  (enter this in the page when it asks)');
    }
    if (value) chosen[name] = value;
  }
  rl.close();

  if (!chosen.SYNC_PASSPHRASE) throw new Error('SYNC_PASSPHRASE is required; the worker fails closed without it.');
  if (!chosen.ALLOWED_ORIGINS) throw new Error('ALLOWED_ORIGINS is required; the worker fails closed without it.');

  console.log('\nUploading secrets...');
  for (const [name, value] of Object.entries(chosen)) {
    const r = await run('npx', ['wrangler', 'secret', 'put', name], { stdin: value + '\n' });
    console.log(`  ${r.code === 0 ? 'ok  ' : 'FAIL'} ${name}`);
    if (r.code !== 0) console.log(r.out);
  }

  console.log('\nDeploying...');
  const dep = await capture('npx', ['wrangler', 'deploy']);
  console.log(dep.out);
  if (dep.code !== 0) throw new Error('deploy failed');

  const url = /(https:\/\/[a-z0-9.-]+\.workers\.dev)/i.exec(dep.out);
  if (url) {
    console.log('\n=== done ===');
    console.log('Worker URL: ' + url[1]);
    console.log('\nNow set this in docs/config.js and push:');
    console.log(`  WORKER_BASE: "${url[1]}",`);
  } else {
    console.log('\nDeployed. Copy the workers.dev URL above into WORKER_BASE in docs/config.js.');
  }
}

main().catch((e) => { console.error('\nERROR: ' + e.message); process.exit(1); });
