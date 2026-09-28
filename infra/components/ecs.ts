import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface EcsClusterArgs {
  namePrefix: string;
}

export class EcsCluster extends pulumi.ComponentResource {
  public readonly cluster: aws.ecs.Cluster;

  constructor(args: EcsClusterArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hashtag-tracker:infra:EcsCluster", `${args.namePrefix}-ecs-cluster`, {}, opts);
    this.cluster = new aws.ecs.Cluster(`${args.namePrefix}-cluster`, {}, { parent: this });
    this.registerOutputs({ clusterArn: this.cluster.arn });
  }
}

const TASK_EXECUTION_ASSUME_ROLE_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: "sts:AssumeRole" }],
});

/**
 * The task EXECUTION role (spec §15.2): used by ECS itself to pull the
 * image and write logs — never sees application secrets. Separate from
 * each service's own task ROLE, which is what's actually scoped per
 * spec §15.2's least-privilege table (only sync-worker reads the Meta
 * secrets, only download-worker writes to S3, etc.).
 */
export function createTaskExecutionRole(namePrefix: string, parent: pulumi.Resource): aws.iam.Role {
  const role = new aws.iam.Role(
    `${namePrefix}-task-execution-role`,
    { assumeRolePolicy: TASK_EXECUTION_ASSUME_ROLE_POLICY },
    { parent }
  );
  new aws.iam.RolePolicyAttachment(
    `${namePrefix}-task-execution-managed-policy`,
    { role: role.name, policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy" },
    { parent }
  );
  return role;
}

export function createTaskRole(namePrefix: string, name: string, parent: pulumi.Resource): aws.iam.Role {
  return new aws.iam.Role(
    `${namePrefix}-${name}-task-role`,
    { assumeRolePolicy: TASK_EXECUTION_ASSUME_ROLE_POLICY },
    { parent }
  );
}

export interface FargateServiceArgs {
  namePrefix: string;
  name: string;
  clusterArn: pulumi.Input<string>;
  image: pulumi.Input<string>;
  cpu: string;
  memory: string;
  desiredCount: number;
  subnetIds: pulumi.Input<pulumi.Input<string>[]>;
  securityGroupIds: pulumi.Input<pulumi.Input<string>[]>;
  executionRoleArn: pulumi.Input<string>;
  taskRoleArn: pulumi.Input<string>;
  environment: { name: string; value: pulumi.Input<string> }[];
  secrets: { name: string; valueFrom: pulumi.Input<string> }[];
  logGroupName: pulumi.Input<string>;
  /** Only the "api" service needs a load balancer target group; omitted for background workers. */
  loadBalancer?: { targetGroupArn: pulumi.Input<string>; containerPort: number };
  region: pulumi.Input<string>;
}

/**
 * One ECS Fargate service (spec §15.1's table: api, sync-worker,
 * download-worker, relay each get one of these — migrations run as a
 * separate one-off task, not a long-running service, see runMigrationTask
 * below). `stopTimeout` (30s) is set below Fargate's own hard maximum and
 * ABOVE the app's SHUTDOWN_GRACE_MS (25s, spec §17) so the app gets its
 * full grace period before ECS force-kills the container (spec §15.1).
 */
export function createFargateService(
  args: FargateServiceArgs,
  parent: pulumi.Resource
): { taskDefinition: aws.ecs.TaskDefinition; service: aws.ecs.Service } {
  const containerDef = pulumi
    .all([args.image, args.logGroupName, args.region])
    .apply(([image, logGroupName, region]) =>
      JSON.stringify([
        {
          name: args.name,
          image,
          essential: true,
          environment: args.environment,
          secrets: args.secrets,
          portMappings: args.loadBalancer ? [{ containerPort: args.loadBalancer.containerPort }] : [],
          // Below Fargate's own maximum and above SHUTDOWN_GRACE_MS (spec
          // §17 default 25000ms) so the app gets its full grace window
          // before ECS sends SIGKILL (spec §15.1).
          stopTimeout: 30,
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": logGroupName,
              "awslogs-region": region,
              "awslogs-stream-prefix": args.name,
            },
          },
        },
      ])
    );

  const taskDefinition = new aws.ecs.TaskDefinition(
    `${args.namePrefix}-${args.name}-task`,
    {
      family: `${args.namePrefix}-${args.name}`,
      requiresCompatibilities: ["FARGATE"],
      networkMode: "awsvpc",
      cpu: args.cpu,
      memory: args.memory,
      executionRoleArn: args.executionRoleArn,
      taskRoleArn: args.taskRoleArn,
      containerDefinitions: containerDef,
    },
    { parent }
  );

  const service = new aws.ecs.Service(
    `${args.namePrefix}-${args.name}-service`,
    {
      cluster: args.clusterArn,
      taskDefinition: taskDefinition.arn,
      desiredCount: args.desiredCount,
      launchType: "FARGATE",
      networkConfiguration: {
        subnets: args.subnetIds,
        securityGroups: args.securityGroupIds,
        assignPublicIp: false,
      },
      loadBalancers: args.loadBalancer
        ? [
            {
              targetGroupArn: args.loadBalancer.targetGroupArn,
              containerName: args.name,
              containerPort: args.loadBalancer.containerPort,
            },
          ]
        : [],
    },
    { parent, dependsOn: [taskDefinition] }
  );

  return { taskDefinition, service };
}

export interface MigrationTaskArgs {
  namePrefix: string;
  image: pulumi.Input<string>;
  executionRoleArn: pulumi.Input<string>;
  taskRoleArn: pulumi.Input<string>;
  environment: { name: string; value: pulumi.Input<string> }[];
  secrets: { name: string; valueFrom: pulumi.Input<string> }[];
  logGroupName: pulumi.Input<string>;
  region: pulumi.Input<string>;
}

/**
 * Migrations run as a one-off ECS RunTask in the deploy pipeline, BEFORE
 * the services above are updated (spec §15.1) — this only defines the
 * task; actually running it (`aws ecs run-task` in CI, or `pulumi up`'s
 * own hooks) is a deploy-time action outside this stack's own apply.
 */
export function createMigrationTaskDefinition(
  args: MigrationTaskArgs,
  parent: pulumi.Resource
): aws.ecs.TaskDefinition {
  const containerDef = pulumi
    .all([args.image, args.logGroupName, args.region])
    .apply(([image, logGroupName, region]) =>
      JSON.stringify([
        {
          name: "migrate",
          image,
          essential: true,
          command: ["npm", "run", "migrate"],
          environment: args.environment,
          secrets: args.secrets,
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": logGroupName,
              "awslogs-region": region,
              "awslogs-stream-prefix": "migrate",
            },
          },
        },
      ])
    );

  return new aws.ecs.TaskDefinition(
    `${args.namePrefix}-migrate-task`,
    {
      family: `${args.namePrefix}-migrate`,
      requiresCompatibilities: ["FARGATE"],
      networkMode: "awsvpc",
      cpu: "256",
      memory: "512",
      executionRoleArn: args.executionRoleArn,
      taskRoleArn: args.taskRoleArn,
      containerDefinitions: containerDef,
    },
    { parent }
  );
}
