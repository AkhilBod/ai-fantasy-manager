import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

let loaded = false;
/** Pull ESPN cookies + shared secret from Secrets Manager into env once per container. */
export async function hydrateEnv(): Promise<void> {
  if (loaded) return;
  const arn = process.env.SECRETS_ARN;
  if (arn) {
    const sm = new SecretsManagerClient({});
    const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
    const obj = JSON.parse(r.SecretString ?? "{}") as Record<string, string>;
    for (const [k, v] of Object.entries(obj)) if (process.env[k] == null) process.env[k] = v;
  }
  loaded = true;
}
