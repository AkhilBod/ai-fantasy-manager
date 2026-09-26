import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { env } from "../config.js";
import { OPEN_STATUSES, localDay, newId, type ActionLog, type InboundMessage, type Negotiation, type OutboundMessage, type Store } from "./types.js";

/**
 * Tables (all PK = `pk`, SK = `sk`):
 *   {prefix}-state         pk=key sk="v"
 *   {prefix}-negotiations  pk=id  sk="n"        GSI open-index: gsi1pk=open|closed
 *   {prefix}-actions       pk=day sk=at#id
 *   {prefix}-messages      pk=phone sk=direction#at#id
 */
export class DynamoStore implements Store {
  private doc: DynamoDBDocumentClient;
  private sqs: SQSClient;
  private t: (n: string) => string;
  constructor(private readonly queueUrl = process.env.OUTBOUND_QUEUE_URL ?? "") {
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.region }), { marshallOptions: { removeUndefinedValues: true } });
    this.sqs = new SQSClient({ region: env.region });
    this.t = (n) => `${env.tablePrefix}-${n}`;
  }
  async getState<T>(key: string) {
    const r = await this.doc.send(new GetCommand({ TableName: this.t("state"), Key: { pk: key, sk: "v" } }));
    return r.Item?.value as T | undefined;
  }
  async setState<T>(key: string, value: T) {
    await this.doc.send(new PutCommand({ TableName: this.t("state"), Item: { pk: key, sk: "v", value } }));
  }
  async putNegotiation(n: Negotiation) {
    await this.doc.send(new PutCommand({ TableName: this.t("negotiations"), Item: { ...n, pk: n.id, sk: "n", gsi1pk: OPEN_STATUSES.has(n.status) ? "open" : "closed" } }));
  }
  async getNegotiation(id: string) {
    const r = await this.doc.send(new GetCommand({ TableName: this.t("negotiations"), Key: { pk: id, sk: "n" } }));
    return r.Item as Negotiation | undefined;
  }
  async listNegotiations(filter: { open?: boolean; phone?: string } = {}) {
    let items: Negotiation[];
    if (filter.open != null) {
      const r = await this.doc.send(new QueryCommand({ TableName: this.t("negotiations"), IndexName: "open-index", KeyConditionExpression: "gsi1pk = :p", ExpressionAttributeValues: { ":p": filter.open ? "open" : "closed" } }));
      items = (r.Items ?? []) as Negotiation[];
    } else {
      const r = await this.doc.send(new ScanCommand({ TableName: this.t("negotiations") }));
      items = (r.Items ?? []) as Negotiation[];
    }
    return filter.phone ? items.filter((n) => n.phone === filter.phone) : items;
  }
  async logAction(a: Omit<ActionLog, "id" | "at">) {
    const at = new Date().toISOString();
    const id = newId("a_");
    await this.doc.send(new PutCommand({ TableName: this.t("actions"), Item: { pk: at.slice(0, 10), sk: `${at}#${id}`, ...a, id, at } }));
  }
  async listActions(sinceIso: string) {
    const days = new Set<string>();
    for (let d = new Date(sinceIso); d <= new Date(); d.setUTCDate(d.getUTCDate() + 1)) days.add(d.toISOString().slice(0, 10));
    days.add(new Date().toISOString().slice(0, 10));
    const out: ActionLog[] = [];
    for (const day of days) {
      const r = await this.doc.send(new QueryCommand({ TableName: this.t("actions"), KeyConditionExpression: "pk = :d", ExpressionAttributeValues: { ":d": day } }));
      for (const it of r.Items ?? []) if ((it as ActionLog).at >= sinceIso) out.push(it as ActionLog);
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }
  async enqueueOutbound(m: Omit<OutboundMessage, "id" | "createdAt">) {
    const full: OutboundMessage = { ...m, id: newId("m_"), createdAt: new Date().toISOString() };
    await this.doc.send(new PutCommand({ TableName: this.t("messages"), Item: { pk: m.phone, sk: `out#${full.createdAt}#${full.id}`, ...full } }));
    if (this.queueUrl) await this.sqs.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(full) }));
    return full;
  }
  async countOutboundToday(phone: string, tz: string) {
    const r = await this.doc.send(new QueryCommand({ TableName: this.t("messages"), KeyConditionExpression: "pk = :p AND begins_with(sk, :s)", ExpressionAttributeValues: { ":p": phone, ":s": "out#" } }));
    const today = localDay(new Date().toISOString(), tz);
    return (r.Items ?? []).filter((i) => localDay((i as OutboundMessage).createdAt, tz) === today).length;
  }
  async listInbound(sinceIso: string) {
    const r = await this.doc.send(new ScanCommand({ TableName: this.t("messages"), FilterExpression: "begins_with(sk, :s) AND #at >= :since", ExpressionAttributeNames: { "#at": "at" }, ExpressionAttributeValues: { ":s": "in#", ":since": sinceIso } }));
    return ((r.Items ?? []) as InboundMessage[]).sort((a, b) => a.at.localeCompare(b.at));
  }
  async recordInbound(m: InboundMessage) {
    try {
      await this.doc.send(new PutCommand({ TableName: this.t("messages"), Item: { pk: m.phone, sk: `in#${m.at}#${m.id}`, ...m }, ConditionExpression: "attribute_not_exists(pk)" }));
      return true;
    } catch (e: any) {
      if (e?.name === "ConditionalCheckFailedException") return false;
      throw e;
    }
  }
}
