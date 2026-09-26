import { App } from "aws-cdk-lib";
import { FfmStack } from "../lib/ffm-stack.js";

const app = new App();
new FfmStack(app, "FfmStack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
});
