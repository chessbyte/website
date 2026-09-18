import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { blogBundle } from './blog-bundling';
import { GitHubDeployRole } from './github-oidc';

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

    // CloudFront Function to handle subdirectory index.html
    const urlRewriteFunction = new cloudfront.Function(this, 'UrlRewriteFunction', {
      code: cloudfront.FunctionCode.fromInline(`
        function handler(event) {
          var request = event.request;
          var uri = request.uri;

          // If URI ends with '/', append index.html
          if (uri.endsWith('/')) {
            request.uri += 'index.html';
          }
          // If URI doesn't have an extension, append /index.html
          else if (!uri.includes('.')) {
            request.uri += '/index.html';
          }

          return request;
        }
      `),
    });

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [{
          function: urlRewriteFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      domainNames: [domainName, `www.${domainName}`],
      certificate,
      defaultRootObject: 'index.html',
      errorResponses: [
        // OAC grants CloudFront s3:GetObject but not s3:ListBucket, so S3
        // answers 403 AccessDenied (not 404 NoSuchKey) for a missing object
        // rather than reveal whether it exists. Without this entry a bad URL
        // leaks S3's AccessDenied XML instead of rendering 404.html.
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
        },
      ],
    });

    // Build blog/ at synth time and upload it, invalidating CloudFront.
    // `distribution` without `distributionPaths` invalidates everything, which
    // is what we want for a site this small.
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [blogBundle()],
      destinationBucket: websiteBucket,
      distribution,
      prune: true,
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

    // Lets .github/workflows/deploy.yml run `cdk deploy` with no stored key.
    // Deployed from a laptop first; CI cannot create the role it needs to
    // authenticate with.
    const githubDeploy = new GitHubDeployRole(this, 'GitHubDeploy', {
      repository: 'chessbyte/website',
      branch: 'main',
    });

    // Outputs
    new cdk.CfnOutput(this, 'GitHubDeployRoleArn', { value: githubDeploy.role.roleArn });
    new cdk.CfnOutput(this, 'BucketName', { value: websiteBucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'WebsiteUrl', { value: `https://${domainName}` });
  }
}
