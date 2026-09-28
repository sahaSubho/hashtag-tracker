import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface EgressFirewallArgs {
  namePrefix: string;
  vpcId: pulumi.Input<string>;
  /** The subnet(s) the firewall endpoint itself lives in — typically one per AZ, in a dedicated firewall subnet. */
  firewallSubnetIds: pulumi.Input<pulumi.Input<string>[]>;
}

const ALLOWED_DOMAINS = [
  "graph.facebook.com",
  ".cdninstagram.com",
  ".fbcdn.net",
]; // spec §15.3: "only graph.facebook.com and the Meta CDN domains"

/**
 * AWS Network Firewall restricting outbound traffic to only Meta's API and
 * CDN domains (spec §13.3, §15.3) — a network-level backstop for the
 * application-level SSRF guard (src/domain/ssrf.ts): even a bug in that
 * guard can't make the download worker reach an arbitrary host, because
 * the network itself won't route the traffic there.
 *
 * This component creates the firewall, its policy, and a domain-allowlist
 * stateful rule group. It does NOT rewire the VPC's route tables to send
 * private-subnet egress through the firewall endpoint first — that step
 * depends on the exact NAT/AZ topology (spec §15.3's own network design)
 * and is a deliberate, explicitly-called-out gap: wiring it blindly here
 * risked silently breaking egress for every other AWS service call
 * (Secrets Manager, S3, SQS) that also needs outbound access, which needs
 * its own VPC endpoints considered alongside the firewall rule, not a
 * generic route-table rewrite. Documented in instructions.md's
 * `production` section as a manual step.
 */
export class EgressFirewall extends pulumi.ComponentResource {
  public readonly ruleGroup: aws.networkfirewall.RuleGroup;
  public readonly policy: aws.networkfirewall.FirewallPolicy;
  public readonly firewall: aws.networkfirewall.Firewall;

  constructor(args: EgressFirewallArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hashtag-tracker:infra:EgressFirewall", `${args.namePrefix}-egress-firewall`, {}, opts);

    this.ruleGroup = new aws.networkfirewall.RuleGroup(
      `${args.namePrefix}-egress-allowlist`,
      {
        capacity: 100,
        type: "STATEFUL",
        ruleGroup: {
          rulesSource: {
            rulesSourceList: {
              generatedRulesType: "ALLOWLIST",
              targetTypes: ["TLS_SNI", "HTTP_HOST"],
              targets: ALLOWED_DOMAINS,
            },
          },
        },
      },
      { parent: this }
    );

    this.policy = new aws.networkfirewall.FirewallPolicy(
      `${args.namePrefix}-egress-policy`,
      {
        firewallPolicy: {
          statelessDefaultActions: ["aws:forward_to_sfe"],
          statelessFragmentDefaultActions: ["aws:forward_to_sfe"],
          statefulRuleGroupReferences: [{ resourceArn: this.ruleGroup.arn }],
          // DROP_ESTABLISHED here means: once the stateful engine has
          // decided a flow doesn't match the allowlist, later packets on
          // that same connection are dropped too, not just the first one.
          statefulDefaultActions: ["aws:drop_established"],
          statefulEngineOptions: { ruleOrder: "STRICT_ORDER" },
        },
      },
      { parent: this }
    );

    this.firewall = new aws.networkfirewall.Firewall(
      `${args.namePrefix}-egress-firewall`,
      {
        vpcId: args.vpcId,
        firewallPolicyArn: this.policy.arn,
        subnetMappings: pulumi.output(args.firewallSubnetIds).apply((ids) => ids.map((subnetId) => ({ subnetId }))),
      },
      { parent: this }
    );

    this.registerOutputs({ firewallArn: this.firewall.arn });
  }
}
