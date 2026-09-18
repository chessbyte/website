---
title: 'Deploy in One Command: Building a Static Site at CDK Synth Time'
description: 'How I collapsed a three-step deploy into `npx cdk deploy` by building the Astro site during CDK synth, using BucketDeployment and a local bundler.'
pubDate: 'Sep 18 2026'
---

When I [first built this site](/blog/building-this-site/), I stopped one step short of done.

The CDK stack provisioned everything: S3 bucket, CloudFront distribution, ACM certificate, Route 53 records. What it never did was put any content in the bucket. So the real deploy procedure looked like this:

```bash
npx cdk deploy
cd blog && npm run build
aws s3 sync ./dist s3://chessbytewebsite-websitebucket75c24d94-xxxxx --delete
aws cloudfront create-invalidation --distribution-id EXXXXX --paths "/*"
```

Four commands, two of which need values I have to go read out of the stack outputs. It works, but it's the kind of thing you get wrong at 11pm, and "did I remember to invalidate?" is not a question I want to be asking about my own blog.

This post is about closing that gap: making `npx cdk deploy` build the site, upload it, and invalidate the cache, in one step.

## TL;DR

- `BucketDeployment` handles upload + invalidation, but it needs an asset to upload
- `blog/dist/` is gitignored, so on a fresh clone there's nothing to point it at
- Instead of committing build output, build during `cdk synth` using `Source.asset().bundling.local.tryBundle`
- Set `assetHashType: OUTPUT` so CDK hashes the build result, not a source tree full of `node_modules/`
- `prune: true` means exactly one source of truth, so plan your file layout accordingly

## The Obvious Fix, and Why It Doesn't Work

CDK ships a construct for precisely this problem:

```typescript
new s3deploy.BucketDeployment(this, 'DeployWebsite', {
  sources: [s3deploy.Source.asset('blog/dist')],
  destinationBucket: websiteBucket,
  distribution,
});
```

`BucketDeployment` uploads the asset to the bucket, and if you hand it a `distribution`, it creates the CloudFront invalidation for you. That's both of my manual steps, gone.

Except `blog/dist/` is build output, and build output is gitignored:

```
# blog/.gitignore
# build output
dist/
```

So on a fresh clone, `blog/dist/` doesn't exist. `Source.asset()` on a missing directory fails at synth. And if it *does* exist but is stale (I edited a post and forgot to rebuild), CDK will happily upload yesterday's site and invalidate the cache so everyone sees it faster.

That leaves two choices:

1. **Commit `dist/`.** Now every content change is a two-file diff: the Markdown and a pile of generated HTML. Review noise, merge conflicts, and a build artifact that can silently drift from its source.
2. **Build it during synth.** The asset is generated as part of the deploy, so it can't be stale and doesn't need to be committed.

Option 2 is what CDK's bundling API is for.

## CDK Asset Bundling

`Source.asset()` takes a `bundling` option. The mental model: instead of uploading the directory as-is, CDK runs a build step and uploads *that* output.

The default execution model is Docker. CDK runs your build command inside a container so it's reproducible regardless of what's installed on the machine. That's the right default for a team, but it means every synth pays container startup, and it means you need Docker running to look at your own infrastructure.

The escape hatch is `local.tryBundle`. If you provide it, CDK calls it first; if it returns `true`, the bundle is done and Docker is never touched. Return `false` and CDK falls back to the container.

Here's the whole thing:

```typescript
// lib/blog-bundling.ts
import { AssetHashType, DockerImage } from 'aws-cdk-lib';
import { ISource, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { execFileSync } from 'child_process';
import { cpSync, existsSync } from 'fs';
import { join } from 'path';

export const BLOG_ROOT = join(__dirname, '../blog');
export const BLOG_DIST_DIR = join(BLOG_ROOT, 'dist');

export function blogBundle(): ISource {
  // npm's cache logic requires HOME; CI sandboxes sometimes invoke CDK without
  // it, which yields cryptic `npm ci` failures.
  const env = { HOME: process.env.HOME ?? '/tmp', ...process.env };

  return Source.asset(BLOG_ROOT, {
    assetHashType: AssetHashType.OUTPUT,
    bundling: {
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
```

Four decisions in there are worth unpacking.

### `assetHashType: OUTPUT`

CDK hashes assets to decide whether anything changed. The default for a bundled asset is `SOURCE`, which hashes the input directory.

That's wrong here. `BLOG_ROOT` is `blog/`, which contains `node_modules/` (tens of thousands of files), `dist/` (the previous build), and `.astro/` (generated types). Hashing all of that is slow, and worse, it isn't stable: `node_modules/` differs between my laptop and CI in ways that have nothing to do with the site's content.

`AssetHashType.OUTPUT` hashes the bundler's output instead: the built site, which is exactly what gets uploaded. Same content in, same hash out, on any machine.

### No real Docker fallback

The `image` and `command` are there because the `bundling` type requires them, but the command is a hard failure with an explanatory message.

This is deliberate. The alternative, an Alpine image that runs some approximation of the build, would mean a machine without npm produces *something* and uploads it. A stub site deployed over the real one is a much worse outcome than a synth that refuses to proceed. `npm` is on `PATH` everywhere this stack gets deployed from; if it isn't, I want to hear about it loudly.

### Forcing `HOME`

`npm ci` needs `HOME` to locate its cache. Interactive shells always have it; some CI sandboxes and process spawners don't, and the resulting failure message doesn't mention `HOME` at all. One line of defense against an afternoon of confused debugging.

Note the spread order: `{ HOME: ..., ...process.env }`. A real `HOME` from the environment always wins over the `/tmp` default.

### The `npm ci` marker

Checking `node_modules/` for existence isn't enough: an interrupted install leaves a partial tree behind. npm writes `node_modules/.package-lock.json` as the *last* step of a successful install, so its presence is a decent proxy for "the install actually finished."

## Wiring It Into the Stack

The stack side is twelve lines:

```typescript
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { blogBundle } from './blog-bundling';

// ...

// Build blog/ at synth time and upload it, invalidating CloudFront.
// `distribution` without `distributionPaths` invalidates everything, which
// is what we want for a site this small.
new s3deploy.BucketDeployment(this, 'DeployWebsite', {
  sources: [blogBundle()],
  destinationBucket: websiteBucket,
  distribution,
  prune: true,
});
```

`prune: true` is the default, but I set it explicitly because it matters. It means the deployment deletes anything in the bucket that isn't in the sources. The bucket becomes an exact mirror of the built site. Delete a post, and it disappears from production instead of lingering at its old URL forever.

## `prune` Made Me Move Two Files

That mirroring is the feature, and it also immediately broke two things.

**`public/404.html`** lived at the repo root, left over from the pre-Astro placeholder era, and the CloudFront distribution references it:

```typescript
errorResponses: [
  { httpStatus: 404, responseHttpStatus: 404, responsePagePath: '/404.html' },
],
```

With one pruning deployment sourced from `blog/dist/`, a file outside that tree isn't "left alone." It's *deleted*. The fix was to move it to `blog/public/404.html` and let Astro's public-directory passthrough copy it into `dist/` on every build. Now it's part of the same source of truth as everything else.

**`public/index.html`** was the original placeholder homepage from before Astro existed, superseded by `blog/src/pages/index.astro`. I could have added it as a second `BucketDeployment` source, and it would have clobbered the real homepage. It was already dead code; it just hadn't had a chance to hurt anyone yet. Deleted.

The general lesson: **a pruning deployment wants exactly one source of truth.** The moment you have two sources, you're reasoning about ordering and precedence between them. Restructure so there's one.

## What I Deliberately Left Out

I borrowed this technique from an internal CDK project that does the same thing for a much larger frontend. That version keeps a build-marker cache: it records a hash of the source files and skips the build when nothing has changed.

I dropped it. The Astro build here takes under a second:

```
[build] 6 page(s) built in 1.10s
```

A cache that saves 900ms, at the cost of a correctness-sensitive invalidation check I'd have to get right, is a bad trade. Caching is a thing you add when you've measured a problem, not a thing you copy along with the pattern. Worth remembering when you lift code from somewhere else: take the technique, re-evaluate the optimizations.

## The Tradeoff: Synth Is a Build Now

This isn't free. `cdk synth` and `cdk deploy` now shell out to npm and build the site, which makes them slower and makes them fail if the toolchain is missing.

Usefully, that's not true of *every* CDK command. CDK only bundles assets for stacks it's actually synthesizing, so the metadata-only commands stay fast. I confirmed this by deleting `blog/dist/` and running each:

```bash
$ rm -rf blog/dist && npx cdk ls
ChessbyteWebsite
$ ls blog/dist
ls: blog/dist: No such file or directory   # no build

$ npx cdk synth > /dev/null
$ ls blog/dist
_astro  404.html  about  blog  favicon.svg   # built
```

So `cdk ls` stays instant, and `cdk synth`/`cdk deploy` pay for a build. For a site that builds in a second, that's the right place for the cost to land.

## The Result

```bash
npx cdk deploy
```

That's the whole deploy. It builds the site, diffs the infrastructure, uploads the changed files, and invalidates CloudFront. No bucket names to copy, no distribution IDs to look up, no forgetting the invalidation.

The site you're reading was deployed with that command.

## Source Code

The full infrastructure code is at [github.com/chessbyte/website](https://github.com/chessbyte/website). The bundler is [`lib/blog-bundling.ts`](https://github.com/chessbyte/website/blob/main/lib/blog-bundling.ts).
