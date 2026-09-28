import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { Network, createAlbSecurityGroup, createApiSecurityGroup, createWorkerSecurityGroup, createRdsSecurityGroup } from "./components/network";
import { Database, MediaBucket, JobQueue, AlertTopic } from "./components/storage";
import { AppSecrets } from "./components/secrets";
import { SyncSchedule } from "./components/scheduler";
import { EcsCluster, createTaskExecutionRole, createTaskRole, createFargateService, createMigrationTaskDefinition } from "./components/ecs";
import { LoadBalancer } from "./components/alb";
import { EgressFirewall } from "./components/firewall";

const config = new pulumi.Config();
const namePrefix = "hashtag-tracker";
const region = aws.config.region ?? "us-east-1";
const containerImage = config.get("containerImage") ?? "REPLACE_ME_WITH_A_REAL_ECR_IMAGE_URI:latest";
const apiContainerPort = 3000;
const hashtagId = config.get("hashtagId") ?? "0"; // real value known only once the hashtag is bootstrapped; set via `pulumi config set hashtagId <id>`

// --- Networking -------------------------------------------------------
const network = new Network({ namePrefix });
const albSg = createAlbSecurityGroup(namePrefix, network.vpcId, network);
const apiSg = createApiSecurityGroup(namePrefix, network.vpcId, albSg.id, apiContainerPort, network);
const syncWorkerSg = createWorkerSecurityGroup(namePrefix, "sync-worker", network.vpcId, network);
const downloadWorkerSg = createWorkerSecurityGroup(namePrefix, "download-worker", network.vpcId, network);
const relaySg = createWorkerSecurityGroup(namePrefix, "relay", network.vpcId, network);
// Only these four services' own security groups may reach RDS (spec
// §15.4 policy) — nothing public, nothing from outside the app.
const rdsSg = createRdsSecurityGroup(
  namePrefix,
  network.vpcId,
  [apiSg.id, syncWorkerSg.id, downloadWorkerSg.id, relaySg.id],
  network
);

// --- Data / storage / messaging ---------------------------------------
const database = new Database({
  namePrefix,
  subnetIds: network.privateSubnetIds,
  securityGroupId: rdsSg.id,
});
const mediaBucket = new MediaBucket({ namePrefix });
const jobQueue = new JobQueue({ namePrefix });
const alertTopic = new AlertTopic({ namePrefix });
const secrets = new AppSecrets({ namePrefix });

new SyncSchedule({
  namePrefix,
  queueArn: jobQueue.queue.arn,
  hashtagId,
});

// The firewall's own resources (rule group, policy, endpoint) are real;
// redirecting private-subnet egress THROUGH this endpoint requires
// route-table changes this stack deliberately does not make automatically
// — see EgressFirewall's own doc comment and instructions.md's
// `production` section for why, and for the manual step.
const egressFirewall = new EgressFirewall({
  namePrefix,
  vpcId: network.vpcId,
  firewallSubnetIds: network.publicSubnetIds,
});

// --- Logging ------------------------------------------------------------
const logGroup = new aws.cloudwatch.LogGroup(`${namePrefix}-logs`, { retentionInDays: 30 });

// --- ECS ------------------------------------------------------------
const ecsCluster = new EcsCluster({ namePrefix });
const executionRole = createTaskExecutionRole(namePrefix, ecsCluster);

// Every task's execution role also needs read access to whichever secrets
// its own container definition references (ECS resolves `secrets` at
// container startup using the EXECUTION role, not the task role) — see
// spec §15.2. Scoped to exactly the four secrets this stack creates.
new aws.iam.RolePolicy(`${namePrefix}-execution-read-secrets`, {
  role: executionRole.id,
  policy: pulumi
    .all([secrets.metaAccessToken.arn, secrets.metaAppSecret.arn, secrets.cursorSigningKeys.arn, secrets.slackWebhookUrl.arn])
    .apply(([t, a, c, s]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: [t, a, c, s] }],
      })
    ),
});

const commonEnv = [
  { name: "NODE_ENV", value: "production" },
  { name: "SECRETS_SOURCE", value: "aws" },
  { name: "AWS_REGION", value: region },
  { name: "HASHTAG", value: "matcha" },
  { name: "AWS_SQS_QUEUE_URL", value: jobQueue.queue.url },
  { name: "AWS_S3_BUCKET", value: mediaBucket.bucket.bucket },
  { name: "AWS_SNS_ALERT_TOPIC_ARN", value: alertTopic.topic.arn },
];

const metaSecretRefs = [
  { name: "META_ACCESS_TOKEN", valueFrom: secrets.metaAccessToken.arn },
  { name: "META_APP_SECRET", valueFrom: secrets.metaAppSecret.arn },
];
const cursorKeySecretRef = [{ name: "CURSOR_SIGNING_KEYS", valueFrom: secrets.cursorSigningKeys.arn }];
const slackSecretRef = [{ name: "SLACK_WEBHOOK_URL", valueFrom: secrets.slackWebhookUrl.arn }];

// --- sync-worker: the ONLY service that reads the Meta secrets (spec §15.2) ---
const syncWorkerTaskRole = createTaskRole(namePrefix, "sync-worker", ecsCluster);
new aws.iam.RolePolicy(`${namePrefix}-sync-worker-secrets`, {
  role: syncWorkerTaskRole.id,
  policy: pulumi
    .all([secrets.metaAccessToken.arn, secrets.metaAppSecret.arn])
    .apply(([t, a]) => JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: [t, a] }],
    })),
});
new aws.iam.RolePolicy(`${namePrefix}-sync-worker-sqs`, {
  role: syncWorkerTaskRole.id,
  policy: jobQueue.queue.arn.apply((arn) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"], Resource: arn }],
    })
  ),
});
createFargateService(
  {
    namePrefix,
    name: "sync-worker",
    clusterArn: ecsCluster.cluster.arn,
    image: containerImage,
    cpu: "256",
    memory: "512",
    desiredCount: 1,
    subnetIds: network.privateSubnetIds,
    securityGroupIds: [syncWorkerSg.id],
    executionRoleArn: executionRole.arn,
    taskRoleArn: syncWorkerTaskRole.arn,
    environment: [...commonEnv, { name: "APP_ROLES", value: "sync-worker" }],
    secrets: [...metaSecretRefs, ...cursorKeySecretRef],
    logGroupName: logGroup.name,
    region,
  },
  ecsCluster
);

// --- download-worker: the ONLY service that can write media objects, media/* only (spec §15.2) ---
const downloadWorkerTaskRole = createTaskRole(namePrefix, "download-worker", ecsCluster);
new aws.iam.RolePolicy(`${namePrefix}-download-worker-s3`, {
  role: downloadWorkerTaskRole.id,
  policy: mediaBucket.bucket.arn.apply((arn) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "s3:PutObject", Resource: `${arn}/media/*` }],
    })
  ),
});
new aws.iam.RolePolicy(`${namePrefix}-download-worker-sqs`, {
  role: downloadWorkerTaskRole.id,
  policy: jobQueue.queue.arn.apply((arn) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"], Resource: arn }],
    })
  ),
});
createFargateService(
  {
    namePrefix,
    name: "download-worker",
    clusterArn: ecsCluster.cluster.arn,
    image: containerImage,
    cpu: "256",
    memory: "512",
    desiredCount: 1,
    subnetIds: network.privateSubnetIds,
    securityGroupIds: [downloadWorkerSg.id],
    executionRoleArn: executionRole.arn,
    taskRoleArn: downloadWorkerTaskRole.arn,
    environment: [...commonEnv, { name: "APP_ROLES", value: "download-worker" }],
    secrets: [...cursorKeySecretRef],
    logGroupName: logGroup.name,
    region,
  },
  ecsCluster
);

// --- relay: outbox/sweeper/watchdog/retention — publishes alerts, no Meta/S3 access ---
const relayTaskRole = createTaskRole(namePrefix, "relay", ecsCluster);
new aws.iam.RolePolicy(`${namePrefix}-relay-sns`, {
  role: relayTaskRole.id,
  policy: alertTopic.topic.arn.apply((arn) =>
    JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sns:Publish", Resource: arn }] })
  ),
});
new aws.iam.RolePolicy(`${namePrefix}-relay-sqs`, {
  role: relayTaskRole.id,
  policy: jobQueue.queue.arn.apply((arn) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["sqs:SendMessage", "sqs:ChangeMessageVisibility"], Resource: arn }],
    })
  ),
});
createFargateService(
  {
    namePrefix,
    name: "relay",
    clusterArn: ecsCluster.cluster.arn,
    image: containerImage,
    cpu: "256",
    memory: "512",
    desiredCount: 1,
    subnetIds: network.privateSubnetIds,
    securityGroupIds: [relaySg.id],
    executionRoleArn: executionRole.arn,
    taskRoleArn: relayTaskRole.arn,
    environment: [...commonEnv, { name: "APP_ROLES", value: "relay" }],
    secrets: [...cursorKeySecretRef, ...slackSecretRef],
    logGroupName: logGroup.name,
    region,
  },
  ecsCluster
);

// --- api: public, behind the ALB; read-only DB access, presigns GetObject ---
const apiTaskRole = createTaskRole(namePrefix, "api", ecsCluster);
new aws.iam.RolePolicy(`${namePrefix}-api-s3-presign`, {
  role: apiTaskRole.id,
  policy: mediaBucket.bucket.arn.apply((arn) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: `${arn}/*` }],
    })
  ),
});

const loadBalancer = new LoadBalancer({
  namePrefix,
  vpcId: network.vpcId,
  publicSubnetIds: network.publicSubnetIds,
  securityGroupId: albSg.id,
  containerPort: apiContainerPort,
});

createFargateService(
  {
    namePrefix,
    name: "api",
    clusterArn: ecsCluster.cluster.arn,
    image: containerImage,
    cpu: "512",
    memory: "1024",
    desiredCount: 2,
    subnetIds: network.privateSubnetIds,
    securityGroupIds: [apiSg.id],
    executionRoleArn: executionRole.arn,
    taskRoleArn: apiTaskRole.arn,
    environment: [...commonEnv, { name: "APP_ROLES", value: "api" }, { name: "PORT", value: String(apiContainerPort) }],
    secrets: [...cursorKeySecretRef],
    logGroupName: logGroup.name,
    loadBalancer: { targetGroupArn: loadBalancer.targetGroup.arn, containerPort: apiContainerPort },
    region,
  },
  ecsCluster
);

// --- migrations: a one-off task definition, run by the deploy pipeline before the services above update ---
const migratorTaskRole = createTaskRole(namePrefix, "migrator", ecsCluster);
const migrationTaskDefinition = createMigrationTaskDefinition(
  {
    namePrefix,
    image: containerImage,
    executionRoleArn: executionRole.arn,
    taskRoleArn: migratorTaskRole.arn,
    environment: commonEnv,
    secrets: [],
    logGroupName: logGroup.name,
    region,
  },
  ecsCluster
);

export const albDnsName = loadBalancer.alb.dnsName;
export const dbEndpoint = database.instance.endpoint;
export const mediaBucketName = mediaBucket.bucket.bucket;
export const jobQueueUrl = jobQueue.queue.url;
export const alertTopicArn = alertTopic.topic.arn;
export const migrationTaskDefinitionArn = migrationTaskDefinition.arn;
export const metaAccessTokenSecretArn = secrets.metaAccessToken.arn;
export const egressFirewallArn = egressFirewall.firewall.arn;
