import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface RdsArgs {
  namePrefix: string;
  subnetIds: pulumi.Input<pulumi.Input<string>[]>;
  securityGroupId: pulumi.Input<string>;
  instanceClass?: string;
}

/**
 * RDS Postgres, encrypted with TLS forced (spec §15.2, §15.4). Pulumi does
 * not manage in-database roles/grants (tracker_app/tracker_graphql/
 * tracker_migrator, spec §5) — that is a gap this stack does not paper
 * over: those roles are created by the app's own migrations
 * (0001_roles.ts), which must run once against this instance before the
 * app services start, exactly as documented in instructions.md's
 * `production` section.
 */
export class Database extends pulumi.ComponentResource {
  public readonly instance: aws.rds.Instance;
  public readonly parameterGroup: aws.rds.ParameterGroup;

  constructor(args: RdsArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hashtag-tracker:infra:Database", `${args.namePrefix}-database`, {}, opts);

    const subnetGroup = new aws.rds.SubnetGroup(
      `${args.namePrefix}-db-subnets`,
      { subnetIds: args.subnetIds },
      { parent: this }
    );

    // rds.force_ssl (spec §15.2: "force TLS") lives on the parameter
    // group, not as an Instance property — RDS has no top-level "force
    // ssl" flag.
    this.parameterGroup = new aws.rds.ParameterGroup(
      `${args.namePrefix}-db-params`,
      {
        family: "postgres16",
        parameters: [{ name: "rds.force_ssl", value: "1" }],
      },
      { parent: this }
    );

    this.instance = new aws.rds.Instance(
      `${args.namePrefix}-db`,
      {
        engine: "postgres",
        engineVersion: "16",
        instanceClass: args.instanceClass ?? "db.t4g.micro",
        allocatedStorage: 20,
        dbSubnetGroupName: subnetGroup.name,
        vpcSecurityGroupIds: [args.securityGroupId],
        parameterGroupName: this.parameterGroup.name,
        storageEncrypted: true,
        // No master password is set here — RDS's IAM database
        // authentication (spec §15.2) is used instead, so there is no
        // long-lived DB password for this stack to create or store.
        iamDatabaseAuthenticationEnabled: true,
        manageMasterUserPassword: true,
        username: "postgres",
        backupRetentionPeriod: 7,
        skipFinalSnapshot: false,
        finalSnapshotIdentifier: `${args.namePrefix}-final-snapshot`,
        deletionProtection: true,
        publiclyAccessible: false,
      },
      { parent: this }
    );

    this.registerOutputs({ endpoint: this.instance.endpoint });
  }
}

export interface MediaBucketArgs {
  namePrefix: string;
}

/**
 * S3 bucket for downloaded media (spec §4.1, §15.3): private, versioned,
 * SSE-KMS encrypted, public access fully blocked, and a bucket policy
 * that denies any non-TLS request.
 */
export class MediaBucket extends pulumi.ComponentResource {
  public readonly bucket: aws.s3.Bucket;
  public readonly kmsKey: aws.kms.Key;

  constructor(args: MediaBucketArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hashtag-tracker:infra:MediaBucket", `${args.namePrefix}-media-bucket`, {}, opts);

    this.kmsKey = new aws.kms.Key(
      `${args.namePrefix}-media-kms`,
      { description: `SSE-KMS key for ${args.namePrefix} media bucket`, enableKeyRotation: true },
      { parent: this }
    );

    this.bucket = new aws.s3.Bucket(`${args.namePrefix}-media`, {}, { parent: this });

    new aws.s3.BucketVersioning(
      `${args.namePrefix}-media-versioning`,
      { bucket: this.bucket.id, versioningConfiguration: { status: "Enabled" } },
      { parent: this }
    );

    new aws.s3.BucketServerSideEncryptionConfiguration(
      `${args.namePrefix}-media-sse`,
      {
        bucket: this.bucket.id,
        rules: [
          {
            applyServerSideEncryptionByDefault: {
              sseAlgorithm: "aws:kms",
              kmsMasterKeyId: this.kmsKey.arn,
            },
          },
        ],
      },
      { parent: this }
    );

    new aws.s3.BucketPublicAccessBlock(
      `${args.namePrefix}-media-pab`,
      {
        bucket: this.bucket.id,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      { parent: this }
    );

    new aws.s3.BucketPolicy(
      `${args.namePrefix}-media-policy`,
      {
        bucket: this.bucket.id,
        policy: this.bucket.arn.apply((arn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "DenyInsecureTransport",
                Effect: "Deny",
                Principal: "*",
                Action: "s3:*",
                Resource: [arn, `${arn}/*`],
                Condition: { Bool: { "aws:SecureTransport": "false" } },
              },
            ],
          })
        ),
      },
      { parent: this }
    );

    this.registerOutputs({ bucketName: this.bucket.bucket });
  }
}

export interface JobQueueArgs {
  namePrefix: string;
}

/** SQS queue for background jobs (spec §4.1), server-side encrypted. */
export class JobQueue extends pulumi.ComponentResource {
  public readonly queue: aws.sqs.Queue;

  constructor(args: JobQueueArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hashtag-tracker:infra:JobQueue", `${args.namePrefix}-job-queue`, {}, opts);

    this.queue = new aws.sqs.Queue(
      `${args.namePrefix}-jobs`,
      {
        sqsManagedSseEnabled: true,
        // Matches SqsQueue's default visibilityTimeoutSeconds (spec §4.1
        // app default 120) — kept in sync manually since Pulumi doesn't
        // read the app's own config.
        visibilityTimeoutSeconds: 120,
      },
      { parent: this }
    );

    this.registerOutputs({ queueUrl: this.queue.url });
  }
}

export interface AlertTopicArgs {
  namePrefix: string;
}

/** SNS topic the watchdog publishes alerts to (spec §12.4). */
export class AlertTopic extends pulumi.ComponentResource {
  public readonly topic: aws.sns.Topic;

  constructor(args: AlertTopicArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hashtag-tracker:infra:AlertTopic", `${args.namePrefix}-alert-topic`, {}, opts);
    this.topic = new aws.sns.Topic(`${args.namePrefix}-alerts`, {}, { parent: this });
    this.registerOutputs({ topicArn: this.topic.arn });
  }
}
