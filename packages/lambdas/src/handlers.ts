import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { dailySummaryJob, inboundJob, lineupJob, tradeScanJob, waiversJob } from "@ffm/core";
import { hydrateEnv } from "./secrets.js";

const wrap = (fn: () => Promise<string>) => async () => {
  await hydrateEnv();
  const out = await fn();
  console.log(out);
  return { ok: true, out };
};

export const lineup = wrap(lineupJob);
export const waivers = wrap(waiversJob);
export const tradeScan = wrap(tradeScanJob);
export const dailySummary = wrap(dailySummaryJob);

type AsyncPayload = { __ffmAsync: true; msg: Parameters<typeof inboundJob>[0] };

export async function inbound(event: APIGatewayProxyEventV2 | AsyncPayload): Promise<APIGatewayProxyResultV2> {
  await hydrateEnv();
  // Second hop: we invoked ourselves asynchronously with the message; do the real work here (no 30s API limit).
  if ((event as AsyncPayload).__ffmAsync) {
    const result = await inboundJob((event as AsyncPayload).msg);
    console.log(`[inbound] ${(event as AsyncPayload).msg.phone}: ${result}`);
    return { statusCode: 200, body: result };
  }
  const ev = event as APIGatewayProxyEventV2;
  if (ev.headers["x-ffm-secret"] !== process.env.INBOUND_API_SECRET) return { statusCode: 401, body: "nope" };
  let body: any;
  try { body = JSON.parse(ev.body ?? "{}"); } catch { return { statusCode: 400, body: "bad json" }; }
  if (typeof body.id !== "string" || typeof body.phone !== "string" || typeof body.text !== "string") return { statusCode: 400, body: "missing fields" };
  const msg = { id: body.id, phone: body.phone, text: String(body.text).slice(0, 2000), isFromMe: Boolean(body.isFromMe), chatName: body.chatName, at: body.at ?? new Date().toISOString() };
  const payload: AsyncPayload = { __ffmAsync: true, msg };
  await new LambdaClient({}).send(new InvokeCommand({ FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME, InvocationType: "Event", Payload: Buffer.from(JSON.stringify(payload)) }));
  return { statusCode: 202, body: "queued" };
}
