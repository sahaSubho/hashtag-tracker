import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface AppSecretsArgs {
  namePrefix: string;
}

/**
 * Secrets Manager secrets for the app, CREATED EMPTY (spec §15.2, §15.4):
 * this stack only declares the secret resources themselves — it never
 * sets `secretString`/a version value for any of them. Real values are
 * set out-of-band by a human, once, via the AWS CLI or console, after
 * `pulumi up` creates the empty secret — the exact reason being that a
 * secret's real value must never pass through Pulumi state (encrypted or
 * not), source control, or a CI log. `infra/index.test.ts` asserts this
 * class never passes a value to any of its `aws.secretsmanager.Secret`
 * resources.
 */
export class AppSecrets extends pulumi.ComponentResource {
  public readonly metaAccessToken: aws.secretsmanager.Secret;
  public readonly metaAppSecret: aws.secretsmanager.Secret;
  public readonly cursorSigningKeys: aws.secretsmanager.Secret;
  public readonly slackWebhookUrl: aws.secretsmanager.Secret;

  constructor(args: AppSecretsArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hashtag-tracker:infra:AppSecrets", `${args.namePrefix}-app-secrets`, {}, opts);

    this.metaAccessToken = new aws.secretsmanager.Secret(
      `${args.namePrefix}-meta-access-token`,
      { description: "Meta Graph API System User access token (set out-of-band, never via Pulumi)" },
      { parent: this }
    );

    this.metaAppSecret = new aws.secretsmanager.Secret(
      `${args.namePrefix}-meta-app-secret`,
      { description: "Meta app secret, for appsecret_proof (set out-of-band)" },
      { parent: this }
    );

    this.cursorSigningKeys = new aws.secretsmanager.Secret(
      `${args.namePrefix}-cursor-signing-keys`,
      { description: "REST/GraphQL cursor HMAC signing keys, kid:key pairs (set out-of-band)" },
      { parent: this }
    );

    this.slackWebhookUrl = new aws.secretsmanager.Secret(
      `${args.namePrefix}-slack-webhook-url`,
      { description: "Optional Slack webhook for LogAlertSink-style notifications (set out-of-band)" },
      { parent: this }
    );

    this.registerOutputs({
      metaAccessTokenArn: this.metaAccessToken.arn,
      metaAppSecretArn: this.metaAppSecret.arn,
      cursorSigningKeysArn: this.cursorSigningKeys.arn,
      slackWebhookUrlArn: this.slackWebhookUrl.arn,
    });
  }
}
