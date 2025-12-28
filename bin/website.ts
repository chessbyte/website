#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { WebsiteStack } from '../lib/website-stack';

const app = new cdk.App();
new WebsiteStack(app, 'ChessbyteWebsite', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1', // Required for CloudFront certificates
  },
});
