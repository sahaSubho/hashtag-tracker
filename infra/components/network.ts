import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface NetworkArgs {
  namePrefix: string;
}

const AVAILABILITY_ZONE_SUFFIXES = ["a", "b"]; // 2 AZs (spec §15.3)
const VPC_CIDR = "10.0.0.0/16";

/**
 * VPC with 2 availability zones, public and private subnets, and one NAT
 * gateway per AZ for the private subnets' outbound traffic (spec §15.3).
 * ECS tasks and RDS live in the private subnets; only the ALB sits in
 * public subnets.
 *
 * Built from plain aws.ec2.* resources rather than awsx.ec2.Vpc: the
 * higher-level awsx component computes publicSubnetIds/privateSubnetIds
 * through its own internal provider calls, which Pulumi's setMocks (used
 * by index.test.ts, spec §15.4) does not resolve without much deeper
 * mocking of awsx's own component machinery — confirmed directly (its
 * subnet-id outputs come back undefined under setMocks even in total
 * isolation). Plain resources are equally valid, real infrastructure and
 * mock cleanly, which is what actually lets index.test.ts assert real
 * facts about the security groups this component creates.
 */
export class Network extends pulumi.ComponentResource {
  public readonly vpc: aws.ec2.Vpc;
  public readonly vpcId: pulumi.Output<string>;
  public readonly privateSubnetIds: pulumi.Output<string>[];
  public readonly publicSubnetIds: pulumi.Output<string>[];

  constructor(args: NetworkArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hashtag-tracker:infra:Network", `${args.namePrefix}-network`, {}, opts);

    this.vpc = new aws.ec2.Vpc(
      `${args.namePrefix}-vpc`,
      { cidrBlock: VPC_CIDR, enableDnsHostnames: true, enableDnsSupport: true },
      { parent: this }
    );
    this.vpcId = this.vpc.id;

    const igw = new aws.ec2.InternetGateway(`${args.namePrefix}-igw`, { vpcId: this.vpc.id }, { parent: this });

    const publicRouteTable = new aws.ec2.RouteTable(
      `${args.namePrefix}-public-rt`,
      { vpcId: this.vpc.id, routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: igw.id }] },
      { parent: this }
    );

    const publicSubnets: aws.ec2.Subnet[] = [];
    const privateSubnets: aws.ec2.Subnet[] = [];

    AVAILABILITY_ZONE_SUFFIXES.forEach((azSuffix, i) => {
      const availabilityZone = pulumi.interpolate`${aws.config.region}${azSuffix}`;

      const publicSubnet = new aws.ec2.Subnet(
        `${args.namePrefix}-public-${azSuffix}`,
        {
          vpcId: this.vpc.id,
          cidrBlock: `10.0.${i}.0/24`,
          availabilityZone,
          mapPublicIpOnLaunch: true,
        },
        { parent: this }
      );
      publicSubnets.push(publicSubnet);
      new aws.ec2.RouteTableAssociation(
        `${args.namePrefix}-public-${azSuffix}-rta`,
        { subnetId: publicSubnet.id, routeTableId: publicRouteTable.id },
        { parent: this }
      );

      const natEip = new aws.ec2.Eip(`${args.namePrefix}-nat-eip-${azSuffix}`, { domain: "vpc" }, { parent: this });
      const natGateway = new aws.ec2.NatGateway(
        `${args.namePrefix}-nat-${azSuffix}`,
        { subnetId: publicSubnet.id, allocationId: natEip.id },
        { parent: this }
      );

      const privateSubnet = new aws.ec2.Subnet(
        `${args.namePrefix}-private-${azSuffix}`,
        {
          vpcId: this.vpc.id,
          cidrBlock: `10.0.${i + 10}.0/24`,
          availabilityZone,
        },
        { parent: this }
      );
      privateSubnets.push(privateSubnet);

      const privateRouteTable = new aws.ec2.RouteTable(
        `${args.namePrefix}-private-${azSuffix}-rt`,
        { vpcId: this.vpc.id, routes: [{ cidrBlock: "0.0.0.0/0", natGatewayId: natGateway.id }] },
        { parent: this }
      );
      new aws.ec2.RouteTableAssociation(
        `${args.namePrefix}-private-${azSuffix}-rta`,
        { subnetId: privateSubnet.id, routeTableId: privateRouteTable.id },
        { parent: this }
      );
    });

    this.publicSubnetIds = publicSubnets.map((s) => s.id);
    this.privateSubnetIds = privateSubnets.map((s) => s.id);

    this.registerOutputs({
      vpcId: this.vpcId,
      privateSubnetIds: this.privateSubnetIds,
      publicSubnetIds: this.publicSubnetIds,
    });
  }
}

/** Security group for the ALB: public HTTPS in, nothing else. */
export function createAlbSecurityGroup(namePrefix: string, vpcId: pulumi.Input<string>, parent: pulumi.Resource) {
  return new aws.ec2.SecurityGroup(
    `${namePrefix}-alb-sg`,
    {
      vpcId,
      ingress: [{ protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] }],
      egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    },
    { parent }
  );
}

/** Security group for the api ECS service: reachable only from the ALB. */
export function createApiSecurityGroup(
  namePrefix: string,
  vpcId: pulumi.Input<string>,
  albSecurityGroupId: pulumi.Input<string>,
  port: number,
  parent: pulumi.Resource
) {
  return new aws.ec2.SecurityGroup(
    `${namePrefix}-api-sg`,
    {
      vpcId,
      ingress: [{ protocol: "tcp", fromPort: port, toPort: port, securityGroups: [albSecurityGroupId] }],
      egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    },
    { parent }
  );
}

/**
 * Security group for a background ECS service (sync-worker, download-
 * worker, relay) that accepts no inbound traffic at all — it only makes
 * outbound calls (to Meta, AWS services, RDS).
 */
export function createWorkerSecurityGroup(namePrefix: string, name: string, vpcId: pulumi.Input<string>, parent: pulumi.Resource) {
  return new aws.ec2.SecurityGroup(
    `${namePrefix}-${name}-sg`,
    {
      vpcId,
      ingress: [],
      egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    },
    { parent }
  );
}

/**
 * RDS security group: reachable on 5432 only from the app's own ECS
 * service security groups (spec §15.4 policy: "only the app's own
 * security groups can reach RDS").
 */
export function createRdsSecurityGroup(
  namePrefix: string,
  vpcId: pulumi.Input<string>,
  allowedSecurityGroupIds: pulumi.Input<string>[],
  parent: pulumi.Resource
) {
  return new aws.ec2.SecurityGroup(
    `${namePrefix}-rds-sg`,
    {
      vpcId,
      ingress: allowedSecurityGroupIds.map((sgId) => ({
        protocol: "tcp",
        fromPort: 5432,
        toPort: 5432,
        securityGroups: [sgId],
      })),
      egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    },
    { parent }
  );
}
