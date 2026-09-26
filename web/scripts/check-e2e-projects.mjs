// Every Playwright project must actually be run by CI, and the blocking job must
// name the one project it blocks on.
//
// The trap this guards: the config gained webkit, ipad and phone, and the
// blocking e2e job's command was a bare `playwright test`. Left alone it would
// have started running all four engines — turning a question about Safari into a
// red build on every commit — while adding a FIFTH project later would sail past
// CI unrun, which is coverage that exists only on paper.
//
// So: the set of projects in the config must equal the set CI runs, and the
// blocking job must pin its project explicitly.
//
// Run: npm run check:e2e-projects   (CI runs it in the web-static job)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(web, 'playwright.config.ts');
const WORKFLOW = join(web, '..', '.github', 'workflows', 'ci.yml');

const config = readFileSync(CONFIG, 'utf8');
const workflow = readFileSync(WORKFLOW, 'utf8');

let bad = 0;
const fail = (why) => {
  console.log(`  BAD  ${why}`);
  bad++;
};

// --- what the config declares ------------------------------------------------
// Count brackets rather than guess with a regex: the entries contain
// `devices['Desktop Chrome']`, whose own `]` ends a lazy match early — which
// found ONE project and reported the config as having none.
function projectsBlock(text) {
  const start = text.indexOf('projects: [');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start + 'projects: '.length; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

const block = projectsBlock(config);
if (block === null) fail('playwright.config.ts: no `projects: [ ... ]` block found');
const declared = block ? [...block.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]) : [];
if (block && declared.length === 0) fail('playwright.config.ts: the projects block names no projects');

// --- what CI runs ------------------------------------------------------------
// Two shapes: a literal --project=webkit, or --project=${{ matrix.project }} fed
// by that job's own `project: [a, b]` matrix.
const run = new Set();
for (const [, name] of workflow.matchAll(/playwright test[^\n]*--project=([a-z0-9-]+)/g)) run.add(name);
if (/--project=\$\{\{\s*matrix\.project\s*\}\}/.test(workflow)) {
  const list = /^\s*project:\s*\[([^\]]+)\]/m.exec(workflow);
  if (!list) fail('ci.yml: a job runs --project=${{ matrix.project }} with no `project: [...]` matrix to feed it');
  else for (const name of list[1].split(',')) run.add(name.trim());
}

for (const name of declared) {
  if (!run.has(name)) fail(`project '${name}' is in playwright.config.ts but no CI job runs it`);
}
for (const name of run) {
  if (!declared.includes(name)) fail(`ci.yml runs --project=${name}, which playwright.config.ts does not declare`);
}

// --- the blocking job names its project --------------------------------------
// A bare `playwright test` here would silently run whatever the config grows to.
const blocking = /playwright test[^\n]*--shard=/.exec(workflow);
if (!blocking) fail('ci.yml: no sharded playwright run found — has the blocking e2e job moved?');
else if (!/--project=/.test(blocking[0])) {
  fail(`ci.yml: the blocking e2e run does not pin a project (${blocking[0].trim()})`);
}

if (bad) {
  if (process.env.GITHUB_ACTIONS)
    console.log(`::error title=E2E projects::${bad} problem(s) — a browser project is unrun or unpinned`);
  console.log(`\n==== e2e projects: ${bad} problem(s) ====`);
  process.exitCode = 1;
} else {
  console.log(`OK: ${declared.length} projects (${declared.join(', ')}), every one run by CI, blocking job pinned`);
}
