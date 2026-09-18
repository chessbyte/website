/**
 * GitHub Actions OIDC federation, so CI can deploy without a stored AWS key.
 *
 * GitHub mints a short-lived signed token per workflow run; AWS exchanges it
 * for STS credentials that expire within the hour. Nothing long-lived is ever
 * held by GitHub.
 *
 * The trust policy is the whole security boundary. `sub` is matched with
 * StringEquals against one exact branch ref, never a wildcard: this repo is
 * public, so a pattern like `repo:owner/name:*` would extend trust to refs an
 * outside contributor can influence.
 *
 * Note what this does NOT contain: the CDK bootstrap's cfn-exec role carries
 * AdministratorAccess, so anything able to run this workflow can reach the
 * whole account. The gate is therefore write access to the branch, which is
 * why main is branch-protected.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

const GITHUB_OIDC_DOMAIN = 'token.actions.githubusercontent.com';

export interface GitHubDeployRoleProps {
  /** `owner/repo` the token must originate from. */
  readonly repository: string;
  /** The single branch whose workflow runs may assume this role. */
  readonly branch: string;
}

export class GitHubDeployRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: GitHubDeployRoleProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // Account-wide resource; this stack owns the only one.
    const provider = new iam.OpenIdConnectProvider(this, 'Provider', {
      url: `https://${GITHUB_OIDC_DOMAIN}`,
      clientIds: ['sts.amazonaws.com'],
    });

    this.role = new iam.Role(this, 'Role', {
      description: `Deploys ${props.repository}@${props.branch} via GitHub Actions`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          // Without the aud check a token minted for any other audience would
          // satisfy the sub condition alone.
          [`${GITHUB_OIDC_DOMAIN}:aud`]: 'sts.amazonaws.com',
          [`${GITHUB_OIDC_DOMAIN}:sub`]: `repo:${props.repository}:ref:refs/heads/${props.branch}`,
        },
      }),
    });

    // The role carries no deploy permissions itself. It can only assume the
    // CDK bootstrap roles, which is what `cdk deploy` actually uses:
    //   deploy          - drives CloudFormation
    //   file-publishing - uploads the bundled blog asset
    //   lookup          - resolves the hosted zone, since cdk.context.json is
    //                     gitignored and CI starts without it
    // image-publishing is omitted; this stack has no container assets.
    const qualifier = cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER;
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: ['deploy', 'file-publishing', 'lookup'].map(
          (name) =>
            `arn:aws:iam::${stack.account}:role/cdk-${qualifier}-${name}-role-${stack.account}-${stack.region}`,
        ),
      }),
    );
  }
}
