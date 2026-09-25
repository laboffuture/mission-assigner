// Every container image tag we name must actually exist.
//
// Three invented tags reached CI in one batch — node:22.21.1-bookworm-slim and
// two MinIO tags on Docker Hub, where MinIO publishes nothing at all. Each cost
// a full CI round trip to discover, and each failed at PULL time with an error
// that says little. This resolves every tag against the registry up front and
// names the ones that do not exist.
//
// Scans: infra/Dockerfile* (FROM lines) and infra/docker-compose*.yml (image:).
// Run: npm run check:images
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const infra = join(root, 'infra');

/** Every image reference in infra/, with where it came from. */
function collect() {
  const refs = [];
  for (const name of readdirSync(infra)) {
    const path = join(infra, name);
    if (name.startsWith('Dockerfile')) {
      for (const [i, line] of readFileSync(path, 'utf8').split('\n').entries()) {
        const m = /^\s*FROM\s+(\S+)/i.exec(line);
        if (m && !/^\$/.test(m[1])) refs.push({ ref: m[1], where: `${name}:${i + 1}` });
      }
    } else if (/^docker-compose.*\.ya?ml$/.test(name)) {
      for (const [i, line] of readFileSync(path, 'utf8').split('\n').entries()) {
        const m = /^\s*image:\s*(\S+)/.exec(line);
        if (m && !/\$\{/.test(m[1])) refs.push({ ref: m[1], where: `${name}:${i + 1}` });
      }
    }
  }
  // A multi-stage build names its own stages in FROM; those are not images.
  const stages = new Set(refs.filter((r) => / AS /i.test(r.ref)).map((r) => r.ref));
  return refs.filter((r) => !stages.has(r.ref));
}

/** Split "quay.io/minio/mc:TAG" into registry, repository and tag. */
function parse(ref) {
  const [name, tag = 'latest'] = ref.split(':');
  const parts = name.split('/');
  const hasRegistry = parts.length > 1 && /[.:]/.test(parts[0]);
  const registry = hasRegistry ? parts.shift() : 'registry-1.docker.io';
  // Docker Hub official images live under library/.
  const repository = !hasRegistry && parts.length === 1 ? `library/${parts[0]}` : parts.join('/');
  return { registry, repository, tag };
}

/** Anonymous pull token, which both Docker Hub and quay.io hand out. */
async function token({ registry, repository }) {
  const url =
    registry === 'registry-1.docker.io'
      ? `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`
      : `https://${registry}/v2/auth?service=${registry}&scope=repository:${repository}:pull`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = await res.json().catch(() => ({}));
  return body.token ?? body.access_token ?? null;
}

async function exists({ registry, repository, tag }) {
  const t = await token({ registry, repository });
  const res = await fetch(`https://${registry}/v2/${repository}/manifests/${tag}`, {
    method: 'HEAD',
    headers: {
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      Accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ].join(', '),
    },
  });
  return { ok: res.status === 200, status: res.status };
}

/**
 * 401/403 means the registry would not TELL us, not that the tag is wrong — and
 * an image we cannot read the manifest for is an image CI cannot pull either.
 * Both are failures, but they are different failures and the message has to say
 * which, or the next person spends an hour looking for a typo that is not there.
 * (MinIO put its images behind authentication in September 2026; the tags were
 * fine and every one of them reported "does not resolve".)
 */
function verdict(status) {
  if (status === 401 || status === 403) {
    return `needs authentication (registry said ${status}) — the tag may be fine, but nothing can pull it anonymously`;
  }
  if (status === 404) return 'does not exist (registry said 404)';
  return `did not resolve (registry said ${status})`;
}

const refs = collect();
if (refs.length === 0) {
  console.log('no image references found in infra/ — has the layout changed?');
  process.exitCode = 1;
} else {
  let bad = 0;
  for (const { ref, where } of refs) {
    const parsed = parse(ref);
    let result;
    try {
      result = await exists(parsed);
    } catch (err) {
      // A network problem is not a bad tag; say so rather than failing a build
      // for it, but do not pretend the tag was checked.
      console.log(`  SKIP ${ref}  (${where}) — registry unreachable: ${err?.message ?? err}`);
      continue;
    }
    if (result.ok) {
      console.log(`  OK   ${ref}  (${where})`);
    } else {
      bad++;
      const why = verdict(result.status);
      console.log(`  BAD  ${ref}  (${where}) — ${why}`);
      console.log(
        `       ${parsed.registry}/${parsed.repository}:${parsed.tag}. Check the real tags before pinning one.`
      );
      if (process.env.GITHUB_ACTIONS) {
        console.log(`::error title=Unusable image::${ref} (${where}) ${why}`);
      }
    }
  }
  console.log(`\n==== Image tags: ${refs.length - bad} resolve, ${bad} do not ====`);
  process.exitCode = bad ? 1 : 0;
}
