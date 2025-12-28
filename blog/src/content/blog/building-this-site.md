---
title: 'Building a Blog on AWS with CDK: From Domain to Deployment'
description: 'How I built chessbyte.com using AWS CDK, S3, CloudFront, and Route 53 in about an hour with Claude Code as my pair programmer.'
pubDate: 'Dec 28 2025'
---

I recently decided to build my own blog. Rather than using a platform like Medium or Hashnode, I wanted full control over my content and infrastructure - plus, building it would be content itself.

I built the entire thing in a single session using [Claude Code](https://claude.com/claude-code) as my pair programmer. From an unused domain in Route 53 to a live site with HTTPS took about an hour.

Here's how I set up [chessbyte.com](https://chessbyte.com) using AWS CDK, S3, CloudFront, and Route 53.

## TL;DR

- **Stack**: S3 + CloudFront + ACM + Route 53, all defined in ~70 lines of CDK TypeScript
- **Time**: ~1 hour from unused domain to live HTTPS site
- **Cost**: Less than $1/month
- **Key insight**: Domain registration and hosted zones are separate things in AWS - you need to connect them manually

## Why Roll Your Own?

| Platform Approach | DIY Approach |
|-------------------|--------------|
| Start writing in 10 minutes | Few hours of setup |
| Limited customization | Full control |
| Platform owns the infrastructure | You own everything |
| Features may change/disappear | Stable, predictable |

For a technical blog, the DIY approach has an extra benefit: the process of building it is itself content worth sharing.

## Why CDK?

I could have used Terraform, Pulumi, or raw CloudFormation. Here's why I went with CDK:

- **TypeScript all the way down** - Same language for infrastructure and application code. One less context switch.
- **High-level constructs** - CDK's L2/L3 constructs handle the boilerplate. `S3BucketOrigin.withOriginAccessControl()` does in one line what would be dozens of lines in CloudFormation.
- **IDE support** - Autocomplete, type checking, and inline docs. No more guessing property names.
- **Escape hatches** - When you need raw CloudFormation, you can drop down to L1 constructs.

## The Architecture

```
Route 53 (DNS) → CloudFront (CDN + HTTPS) → S3 (Static Files)
                      ↓
                ACM Certificate
```

- **S3**: Stores the static HTML, CSS, JS files
- **CloudFront**: Global CDN for fast delivery + handles HTTPS
- **ACM**: Free SSL certificate from AWS
- **Route 53**: DNS management (I already had my domain registered here)

## Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js and npm installed
- A domain registered in Route 53 (or elsewhere, but Route 53 makes it easier)

## Step 1: Initialize the CDK Project

```bash
mkdir website && cd website
npx cdk init app --language typescript
```

> **Heads up**: `cdk init` requires an empty directory. If you have files there already, move them out, run `cdk init`, then move them back.

This scaffolds a TypeScript CDK project with:
- `lib/` - Where our stack definitions live
- `bin/` - Entry point for the CDK app
- `cdk.json` - CDK configuration

## Step 2: Install Dependencies

```bash
npm install
```

The key constructs we'll use are all in `aws-cdk-lib`:
- `aws_s3` - S3 bucket for hosting
- `aws_cloudfront` - CDN distribution
- `aws_cloudfront_origins` - Connect CloudFront to S3
- `aws_certificatemanager` - SSL certificate
- `aws_route53` - DNS records
- `aws_route53_targets` - Connect Route 53 to CloudFront

## Step 3: Define the Infrastructure

Here's the full stack (we'll walk through each part):

```typescript
// lib/website-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

export class WebsiteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const domainName = 'chessbyte.com';

    // Look up the hosted zone by domain name
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName,
    });

    // SSL Certificate (must be in us-east-1 for CloudFront)
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName,
      subjectAlternativeNames: [`www.${domainName}`],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // S3 bucket for static content
    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      domainNames: [domainName, `www.${domainName}`],
      certificate,
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
        },
      ],
    });

    // DNS records
    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    new route53.ARecord(this, 'WwwAliasRecord', {
      zone: hostedZone,
      recordName: 'www',
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    // Outputs
    new cdk.CfnOutput(this, 'BucketName', { value: websiteBucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'WebsiteUrl', { value: `https://${domainName}` });
  }
}
```

### Key Decisions Explained

**Origin Access Control (OAC)**: We use `S3BucketOrigin.withOriginAccessControl()` instead of making the bucket public. This means only CloudFront can access the bucket - more secure.

**Certificate Validation**: Using DNS validation with our Route 53 hosted zone means AWS automatically creates the validation records. No manual steps.

**Error Responses**: We serve a custom 404.html page when files aren't found. For a single-page app, you'd want to return 200 with index.html instead to handle client-side routing.

## Step 4: Configure the CDK App

```typescript
// bin/website.ts
import * as cdk from 'aws-cdk-lib';
import { WebsiteStack } from '../lib/website-stack';

const app = new cdk.App();
new WebsiteStack(app, 'ChessbyteWebsite', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1', // Required for CloudFront certificates
  },
});
```

> **Heads up**: The stack must be deployed to `us-east-1` because CloudFront requires ACM certificates to be in that region. This isn't optional - your deployment will fail if you try another region.

## Step 5: Connect the Domain to the Hosted Zone

This step confused me at first, so let me explain.

In AWS Route 53, there are two separate concepts:

1. **Domain Registration** - You own `chessbyte.com`. This is like owning a house's address.
2. **Hosted Zone** - A container for DNS records that tell the internet where to find your services. This is like the actual routing instructions.

When you register a domain, it doesn't automatically use your hosted zone. My domain was pointing to parking nameservers (`ns01.cashparking.com`) - basically a "this domain is parked" page.

To connect them, you update the domain's nameservers to point to your hosted zone's nameservers.

First, find your hosted zone's nameservers:

```bash
aws route53 get-hosted-zone --id YOUR_HOSTED_ZONE_ID --query 'DelegationSet.NameServers'
```

Then update the domain registration:

```bash
aws route53domains update-domain-nameservers \
  --region us-east-1 \
  --domain-name chessbyte.com \
  --nameservers \
    Name=ns-719.awsdns-25.net \
    Name=ns-295.awsdns-36.com \
    Name=ns-1306.awsdns-35.org \
    Name=ns-1765.awsdns-28.co.uk
```

Now when someone visits `chessbyte.com`, the internet asks these Route 53 nameservers where to go, and they'll return whatever records we define in our hosted zone.

> **Heads up**: Do this before deploying the CDK stack. The SSL certificate validation requires the domain to be connected to the hosted zone so AWS can automatically create and verify DNS records.

## Step 6: Deploy

```bash
npx cdk bootstrap  # First time only
npx cdk deploy
```

The deployment will:
1. Create the S3 bucket
2. Request the SSL certificate and validate it via DNS
3. Create the CloudFront distribution
4. Set up the DNS records

My deployment took about 7 minutes. The SSL certificate validated automatically in ~2 minutes (thanks to the DNS validation with Route 53), and CloudFront distribution took another ~4 minutes.

The output shows the resources created:

```
Outputs:
ChessbyteWebsite.BucketName = chessbytewebsite-websitebucket75c24d94-xxxxx
ChessbyteWebsite.DistributionDomain = dxxxxx.cloudfront.net
ChessbyteWebsite.DistributionId = EXXXXX
ChessbyteWebsite.WebsiteUrl = https://chessbyte.com
```

## Step 7: Upload Content

After deployment, upload your static site:

```bash
aws s3 sync ./public s3://YOUR_BUCKET_NAME --region us-east-1
```

**Note**: The CloudFront URL works immediately, but your custom domain may take a few minutes for DNS to propagate. You can verify your site is working by hitting the CloudFront URL directly first.

## Adding Astro for the Blog

With the infrastructure in place, I needed a way to write blog posts in Markdown and generate HTML. I chose [Astro](https://astro.build/) because:

- Same TypeScript/Node.js ecosystem as CDK
- No runtime JavaScript by default (fast pages)
- Built-in Markdown support with syntax highlighting
- Free and open-source (MIT license)

```bash
npm create astro@latest blog -- --template blog --typescript strict
cd blog && npm install
```

This creates a `blog/` subdirectory with:
- `src/content/blog/` - Markdown posts with front matter
- `src/pages/` - Page templates
- `astro.config.mjs` - Site configuration

Each post is a Markdown file with YAML front matter:

```markdown
---
title: 'My Post Title'
description: 'A short description'
pubDate: 'Dec 28 2025'
---

Post content here...
```

Build and preview locally:

```bash
npm run build    # Outputs to dist/
npm run preview  # Local preview server
```

Then sync to S3:

```bash
aws s3 sync ./dist s3://YOUR_BUCKET_NAME --delete
aws cloudfront create-invalidation --distribution-id YOUR_DIST_ID --paths "/*"
```

## Next Steps

- Set up GitHub Actions for automatic deployments
- Add analytics (Plausible or Fathom for privacy-friendly tracking)
- Syndicate to Medium and LinkedIn (POSSE strategy)

## Cost

For a low-traffic blog:
- **S3**: ~$0.02/month
- **CloudFront**: Free tier covers 1TB/month
- **Route 53**: $0.50/month for hosted zone
- **ACM**: Free

**Total: Less than $1/month**

## Source Code

The full infrastructure code is available at [github.com/chessbyte/website](https://github.com/chessbyte/website).

---

*This post was written while building the very infrastructure it describes, with Claude Code as my pair programmer. Meta, I know.*
