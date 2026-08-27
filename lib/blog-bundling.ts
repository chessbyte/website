/**
 * Synth-time bundling for blog/ (Astro).
 *
 * `blog/dist/` is gitignored, so on a fresh clone CDK has no asset to upload.
 * We build at synth time via `Source.asset(...).bundling.local.tryBundle`.
 * `npm` is on PATH wherever CDK runs, so we shell out directly and let a real
 * failure surface as a synth error rather than masking it with a Docker
 * fallback that would silently upload a stub.
 *
 * Technique borrowed from an internal CDK project's frontend bundling, minus
 * its build-marker cache — the Astro build here takes ~1s, so there is nothing
 * worth caching.
 */
import { AssetHashType, DockerImage } from 'aws-cdk-lib';
import { ISource, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { execFileSync } from 'child_process';
import { cpSync, existsSync } from 'fs';
import { join } from 'path';

export const BLOG_ROOT = join(__dirname, '../blog');
export const BLOG_DIST_DIR = join(BLOG_ROOT, 'dist');

/** Produces the ISource fed to BucketDeployment: `npm ci` (if needed) + `npm run build`. */
export function blogBundle(): ISource {
  // npm's cache logic requires HOME; CI sandboxes sometimes invoke CDK without
  // it, which yields cryptic `npm ci` failures.
  const env = { HOME: process.env.HOME ?? '/tmp', ...process.env };

  return Source.asset(BLOG_ROOT, {
    // BLOG_ROOT contains node_modules/, dist/ and .astro/ — hashing those (the
    // default SOURCE behavior) is slow and non-deterministic across machines.
    // Hash the built output instead, which is what actually gets uploaded.
    assetHashType: AssetHashType.OUTPUT,
    bundling: {
      // Docker fallback intentionally absent — npm is always on PATH where CDK
      // runs, so a missing toolchain should hard-fail at synth rather than
      // silently produce a stub.
      image: DockerImage.fromRegistry('alpine'),
      command: [
        'sh',
        '-c',
        'echo "blog bundling requires local npm; Docker fallback not supported" && exit 1',
      ],
      local: {
        tryBundle(outputDir: string): boolean {
          try {
            execFileSync('npm', ['--version'], { stdio: ['ignore', 'ignore', 'inherit'] });
          } catch {
            return false;
          }

          // npm writes .package-lock.json at the end of a successful install,
          // so an interrupted run leaves it absent.
          if (!existsSync(join(BLOG_ROOT, 'node_modules/.package-lock.json'))) {
            execFileSync('npm', ['ci', '--no-audit', '--no-fund'], {
              cwd: BLOG_ROOT,
              env,
              stdio: ['ignore', process.stderr, 'inherit'],
            });
          }

          execFileSync('npm', ['run', 'build'], {
            cwd: BLOG_ROOT,
            env,
            stdio: ['ignore', process.stderr, 'inherit'],
          });

          cpSync(BLOG_DIST_DIR, outputDir, { recursive: true });
          return true;
        },
      },
    },
  });
}
