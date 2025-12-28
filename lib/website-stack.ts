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
