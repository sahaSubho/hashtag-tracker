import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface LoadBalancerArgs {
  namePrefix: string;
  vpcId: pulumi.Input<string>;
  publicSubnetIds: pulumi.Input<pulumi.Input<string>[]>;
  securityGroupId: pulumi.Input<string>;
  containerPort: number;
}

/**
 * Public ALB in front of the api service, with a WAF web ACL attached
 * (spec §15.1). The listener is HTTPS-only on 443 — the security group
 * (network.ts) already blocks everything else, this is the ALB-level
 * enforcement of the same rule (no HTTP listener exists at all, so there
 * is nothing to redirect from).
 */
export class LoadBalancer extends pulumi.ComponentResource {
  public readonly alb: aws.lb.LoadBalancer;
  public readonly targetGroup: aws.lb.TargetGroup;
  public readonly listener: aws.lb.Listener;
  public readonly webAcl: aws.wafv2.WebAcl;

  constructor(args: LoadBalancerArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hashtag-tracker:infra:LoadBalancer", `${args.namePrefix}-alb`, {}, opts);

    this.alb = new aws.lb.LoadBalancer(
      `${args.namePrefix}-alb`,
      {
        loadBalancerType: "application",
        internal: false,
        securityGroups: [args.securityGroupId],
        subnets: args.publicSubnetIds,
      },
      { parent: this }
    );

    this.targetGroup = new aws.lb.TargetGroup(
      `${args.namePrefix}-api-tg`,
      {
        port: args.containerPort,
        protocol: "HTTP",
        targetType: "ip",
        vpcId: args.vpcId,
        healthCheck: { path: "/healthz", protocol: "HTTP" },
      },
      { parent: this }
    );

    // A real deployment supplies an ACM certificate ARN via config; a
    // placeholder here would be actively misleading (it can't be applied),
    // so this is left for whoever runs `pulumi up` to fill in via
    // `pulumi config set albCertificateArn <arn>` — the listener
    // definition itself, and the fact that it is HTTPS-only, is the part
    // this stack commits to.
    const certificateArn = new pulumi.Config().require("albCertificateArn");

    this.listener = new aws.lb.Listener(
      `${args.namePrefix}-alb-listener`,
      {
        loadBalancerArn: this.alb.arn,
        port: 443,
        protocol: "HTTPS",
        certificateArn,
        sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
        defaultActions: [{ type: "forward", targetGroupArn: this.targetGroup.arn }],
      },
      { parent: this }
    );

    this.webAcl = new aws.wafv2.WebAcl(
      `${args.namePrefix}-waf`,
      {
        scope: "REGIONAL",
        defaultAction: { allow: {} },
        visibilityConfig: {
          cloudwatchMetricsEnabled: true,
          metricName: `${args.namePrefix}-waf`,
          sampledRequestsEnabled: true,
        },
        rules: [
          {
            name: "AWSManagedRulesCommonRuleSet",
            priority: 0,
            overrideAction: { none: {} },
            statement: {
              managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesCommonRuleSet" },
            },
            visibilityConfig: {
              cloudwatchMetricsEnabled: true,
              metricName: `${args.namePrefix}-waf-common`,
              sampledRequestsEnabled: true,
            },
          },
          {
            name: "RateLimit",
            priority: 1,
            action: { block: {} },
            statement: {
              rateBasedStatement: { limit: 2000, aggregateKeyType: "IP" },
            },
            visibilityConfig: {
              cloudwatchMetricsEnabled: true,
              metricName: `${args.namePrefix}-waf-rate-limit`,
              sampledRequestsEnabled: true,
            },
          },
        ],
      },
      { parent: this }
    );

    new aws.wafv2.WebAclAssociation(
      `${args.namePrefix}-waf-assoc`,
      { resourceArn: this.alb.arn, webAclArn: this.webAcl.arn },
      { parent: this }
    );

    this.registerOutputs({ dnsName: this.alb.dnsName });
  }
}
