import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sm from "aws-cdk-lib/aws-secretsmanager";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { TimeZone } from "aws-cdk-lib";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";

const root = resolve(import.meta.dirname, "../../..");
const PREFIX = "ffm";

/** Keep whatever DRY_RUN the running Lambdas have, so a code redeploy never silently flips live ↔ dry. */
function deployedDryRun(): string {
  try {
    const out = execFileSync("aws", ["lambda", "get-function-configuration", "--function-name", `${PREFIX}-lineup`, "--query", "Environment.Variables.DRY_RUN", "--output", "text"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "0" ? "0" : "1";
  } catch {
    return "1";
  }
}

export class FfmStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const league = readFileSync(resolve(root, "config/league.json"), "utf8");
    const rules = readFileSync(resolve(root, "config/rules.json"), "utf8");
    const leagueCfg = JSON.parse(league) as { timezone?: string; teams: Record<string, { phone?: string; self?: boolean }> };
    const tz = leagueCfg.timezone ?? "America/New_York";
    const myPhone = Object.values(leagueCfg.teams).find((t) => t.self)?.phone ?? "";

    const table = (name: string, extra?: (t: dynamodb.Table) => void) => {
      const t = new dynamodb.Table(this, `${name}Table`, {
        tableName: `${PREFIX}-${name}`,
        partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: RemovalPolicy.RETAIN,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      });
      extra?.(t);
      return t;
    };
    const state = table("state");
    const negotiations = table("negotiations", (t) =>
      t.addGlobalSecondaryIndex({ indexName: "open-index", partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING } }));
    const actions = table("actions");
    const messages = table("messages");

    const dlq = new sqs.Queue(this, "OutboundDlq", { retentionPeriod: Duration.days(14) });
    const outbound = new sqs.Queue(this, "OutboundQueue", {
      queueName: `${PREFIX}-outbound-imessage`,
      visibilityTimeout: Duration.minutes(2),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    const bucket = new s3.Bucket(this, "ProfileBucket", {
      removalPolicy: RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
    });

    // Fill after deploy: aws secretsmanager put-secret-value --secret-id ffm/secrets --secret-string '{"ESPN_S2":"...","ESPN_SWID":"{...}","INBOUND_API_SECRET":"..."}'
    const secret = new sm.Secret(this, "Secrets", {
      secretName: `${PREFIX}/secrets`,
      generateSecretString: { secretStringTemplate: JSON.stringify({ ESPN_S2: "", ESPN_SWID: "", ANTHROPIC_API_KEY: "" }), generateStringKey: "INBOUND_API_SECRET", excludePunctuation: true, passwordLength: 40 },
    });

    const alerts = new sns.Topic(this, "Alerts");
    if (process.env.ALERT_EMAIL) alerts.addSubscription(new subs.EmailSubscription(process.env.ALERT_EMAIL));

    const fn = (name: string, handler: string, timeout = Duration.minutes(5)) => {
      const f = new NodejsFunction(this, `${name}Fn`, {
        functionName: `${PREFIX}-${name}`,
        entry: resolve(root, "packages/lambdas/src/handlers.ts"),
        handler,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 1024,
        timeout,
        logRetention: logs.RetentionDays.ONE_MONTH,
        bundling: { format: OutputFormat.ESM, mainFields: ["module", "main"], banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
        environment: {
          STORE: "dynamo",
          TABLE_PREFIX: PREFIX,
          DRY_RUN: process.env.DRY_RUN ?? deployedDryRun(),
          // Provider is chosen at runtime: ANTHROPIC_API_KEY in the secret → Anthropic API, otherwise Bedrock.
          ...(process.env.LLM_PROVIDER ? { LLM_PROVIDER: process.env.LLM_PROVIDER } : {}),
          LLM_MODEL: process.env.LLM_MODEL ?? "claude-opus-5",
          OUTBOUND_QUEUE_URL: outbound.queueUrl,
          PROFILE_BUCKET: bucket.bucketName,
          SECRETS_ARN: secret.secretArn,
          LEAGUE_CONFIG_JSON: league,
          RULES_JSON: rules,
          MY_PHONE: myPhone,
          NODE_OPTIONS: "--enable-source-maps",
        },
      });
      for (const t of [state, negotiations, actions, messages]) t.grantReadWriteData(f);
      outbound.grantSendMessages(f);
      bucket.grantRead(f);
      secret.grantRead(f);
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], resources: ["*"] }));
      new cw.Alarm(this, `${name}Errors`, { metric: f.metricErrors({ period: Duration.hours(1) }), threshold: 1, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING })
        .addAlarmAction(new cwActions.SnsAction(alerts));
      return f;
    };

    const lineup = fn("lineup", "lineup");
    const waivers = fn("waivers", "waivers", Duration.minutes(10));
    const tradeScan = fn("trade-scan", "tradeScan", Duration.minutes(10));
    const dailySummary = fn("daily-summary", "dailySummary", Duration.minutes(2));
    const inbound = fn("inbound", "inbound", Duration.minutes(5));
    // The API handler re-invokes itself asynchronously so the 30s API Gateway limit never cuts off a negotiation.
    inbound.addToRolePolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${PREFIX}-inbound`] }));

    const schedule = (name: string, cron: string, target: lambda.IFunction) =>
      new scheduler.Schedule(this, `${name}Schedule`, {
        scheduleName: `${PREFIX}-${name}`,
        schedule: scheduler.ScheduleExpression.expression(`cron(${cron})`, TimeZone.of(tz)),
        target: new targets.LambdaInvoke(target),
      });
    // minutes hours day-of-month month day-of-week year
    schedule("waivers", "0 21 ? * TUE *", waivers);
    schedule("trade-scan", "0 10 * * ? *", tradeScan); // daily: new offers (capped per week), nudges, incoming reviews
    schedule("lineup-thu", "0 18 ? * THU *", lineup);
    schedule("lineup-sun-am", "0 10 ? * SUN *", lineup);
    schedule("lineup-sun-pm", "0 15 ? * SUN *", lineup);
    schedule("lineup-mon", "0 18 ? * MON *", lineup);
    schedule("daily-summary", "0 9 * * ? *", dailySummary);

    const api = new apigw.HttpApi(this, "InboundApi", { apiName: `${PREFIX}-inbound` });
    api.addRoutes({ path: "/inbound", methods: [apigw.HttpMethod.POST], integration: new HttpLambdaIntegration("InboundInt", inbound) });

    // Mac agent user: read the outbound queue only.
    const macUser = new iam.User(this, "MacAgentUser", { userName: `${PREFIX}-mac-agent` });
    outbound.grantConsumeMessages(macUser);
    const key = new iam.AccessKey(this, "MacAgentKey", { user: macUser });

    new CfnOutput(this, "InboundApiUrl", { value: `${api.apiEndpoint}/inbound` });
    new CfnOutput(this, "OutboundQueueUrl", { value: outbound.queueUrl });
    new CfnOutput(this, "ProfileBucketName", { value: bucket.bucketName });
    new CfnOutput(this, "SecretName", { value: secret.secretName });
    new CfnOutput(this, "MacAgentAccessKeyId", { value: key.accessKeyId });
    new CfnOutput(this, "MacAgentSecretAccessKey", { value: key.secretAccessKey.unsafeUnwrap() });
  }
}
