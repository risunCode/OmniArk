import * as crypto from "node:crypto";

// Updated to match qodercli 1.0.22 capture (api2.qoder.sh host, new headers,
// new business object, top-level `system` field). The earlier api3 host was
// the qoder2api reverse-engineered fallback that the server still served but
// did NOT charge against the qmodel_latest free-quota bucket.
const COSY_VERSION = "1.0.22";
const APPCODE = "cosy";
const SIG_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw=="; // base64("war, war never changes")
export const JOB_TOKEN_URL = "https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1";
export const USER_STATUS_URL = "https://center.qoder.sh/algo/api/v3/user/status?Encode=1";
export const QOTA_USAGE_URL = "https://openapi.qoder.sh/api/v2/quota/usage";
// COSY-signed GET. Returns per-model promo "free quota" buckets (e.g. qmodel_latest 200/day),
// distinct from QOTA_USAGE_URL which reports the account-wide credit balance.
export const ACTIVITY_URL = "https://openapi.qoder.sh/algo/api/v2/activity";

// Business descriptors sent in body.business and Cosy-Business-* headers.
// CLI uses product=cli, type=agent. Required for the server to attribute
// the request to the right billing/promo bucket.
const BUSINESS_PRODUCT = "cli";
const BUSINESS_TYPE = "agent";
const BUSINESS_VERSION = "1.0.22"; // matches Cosy-Version
const COSY_SCENE = "assistant";

export function openApiHeaders(securityOauthToken: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${securityOauthToken}`,
    "Cosy-ClientType": "5",
    "Cosy-Version": COSY_VERSION,
    "User-Agent": "qoder/" + COSY_VERSION,
  };
}

// 1024-bit RSA pubkey extracted from qodercli bundle. Server uses this to decrypt
// the per-session AES key. Rotation by Qoder will break all clients at once.
const SERVER_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CUSTOM_PAD = "$";

const C2S = new Array(128).fill(-1);
const S2C = new Array(128).fill(-1);
for (let i = 0; i < 64; i++) {
  C2S[CUSTOM_ALPHABET.charCodeAt(i)] = STD_ALPHABET.charCodeAt(i);
  S2C[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
}
C2S[CUSTOM_PAD.charCodeAt(0)] = "=".charCodeAt(0);
S2C["=".charCodeAt(0)] = CUSTOM_PAD.charCodeAt(0);

export function encodeQoderPayload(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  const std = bytes.toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.substring(n - a) + std.substring(a, n - a) + std.substring(0, a);
  let out = "";
  for (let i = 0; i < n; i++) {
    const c = rearranged.charCodeAt(i);
    const m = c < 128 ? S2C[c] : -1;
    if (m < 0) throw new Error(`char out of alphabet: ${rearranged[i]}`);
    out += String.fromCharCode(m);
  }
  return out;
}

function rfc1123Date(d = new Date()): string {
  return d.toUTCString();
}

function md5Hex(s: string): string {
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

function signSignatureHeader(date: string): string {
  return md5Hex(`${APPCODE}&${SIG_SECRET}&${date}`);
}

function rsaEncryptKey(tempKey: Buffer): Buffer {
  return crypto.publicEncrypt(
    { key: SERVER_PUBKEY_PEM, padding: crypto.constants.RSA_PKCS1_PADDING },
    tempKey,
  );
}

function aesEncryptCbc(plain: Buffer, key: Buffer): Buffer {
  // IV = key (matches Java BearerBuilder)
  const cipher = crypto.createCipheriv("aes-128-cbc", key, key);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

interface AuthIdentity {
  name: string;
  aid: string;
  uid: string;
  yx_uid: string;
  organization_id: string;
  organization_name: string;
  user_type: string;
  security_oauth_token: string;
  refresh_token: string;
}

interface SessionContext {
  cosyKey: string; // base64(RSA(tempKey))
  info: string;    // base64(AES(identityJson, tempKey))
}

function buildSessionContext(identity: AuthIdentity): SessionContext {
  const tempKey = Buffer.from(crypto.randomUUID().replace(/-/g, "").slice(0, 16), "ascii");
  const cosyKey = rsaEncryptKey(tempKey).toString("base64");
  const info = aesEncryptCbc(Buffer.from(JSON.stringify(identity), "utf8"), tempKey).toString("base64");
  return { cosyKey, info };
}

function buildPayloadB64(info: string): string {
  // Insertion order matches qodercli 1.0.22 capture exactly:
  // {"version","requestId","info","cosyVersion","ideVersion"}
  // (NOT alphabetically sorted as the older qoder2api Java port did)
  const m = {
    version: "v1",
    requestId: crypto.randomUUID(),
    info,
    cosyVersion: COSY_VERSION,
    ideVersion: "",
  };
  return Buffer.from(JSON.stringify(m), "utf8").toString("base64");
}

function signBearerRequest(payloadB64: string, cosyKey: string, cosyDate: string, body: string, pathSig: string): string {
  return md5Hex(`${payloadB64}\n${cosyKey}\n${cosyDate}\n${body}\n${pathSig}`);
}

function pathSigFromUrl(fullUrl: string): string {
  const u = new URL(fullUrl);
  return u.pathname.startsWith("/algo") ? u.pathname.slice("/algo".length) : u.pathname;
}

export interface QoderTokens {
  personalToken: string;
  securityOauthToken?: string;
  refreshToken?: string;
  userId?: string;
  userName?: string;
  userType?: string;
  plan?: string;
  expireTime?: number;
  email?: string;
  machineId: string;
  machineToken: string;
  machineType: string;
}

export function generateMachineIdentity() {
  // Mirror qodercli 1.0.22 layout: machineToken == machineId (same UUID),
  // machineType is the literal client type "5" (NOT a random hex blob).
  const machineId = crypto.randomUUID();
  const machineToken = machineId;
  const machineType = "5";
  return { machineId, machineToken, machineType };
}

export function signatureHeaders(tokens: QoderTokens): Record<string, string> {
  const date = rfc1123Date();
  return {
    "cosy-machinetoken": tokens.machineToken,
    "cosy-machinetype": tokens.machineType,
    "login-version": "v2",
    appcode: APPCODE,
    accept: "application/json",
    "accept-encoding": "identity",
    "cosy-version": COSY_VERSION,
    "cosy-clienttype": "5",
    date,
    signature: signSignatureHeader(date),
    "content-type": "application/json",
    "cosy-machineid": tokens.machineId,
    "user-agent": "Go-http-client/2.0",
  };
}

export interface JobTokenResponse {
  id?: string;
  name?: string;
  securityOauthToken?: string;
  refreshToken?: string;
  expireTime?: number;
  email?: string;
  plan?: string;
  userType?: string;
}

export interface QoderActivity {
  type: string;
  activityId: string;
  modelName: string;
  modelKeys: string[];
  limit: number;
  used: number;
  remaining: number;
  resetAt: number;
  resetStrategy: string;
  serverTimezone: string;
  description?: string;
  statusText?: string;
  tag?: string;
  tagStyle?: string;
  eligible: boolean;
  activityEndAt: number;
  detailUrl?: string;
}

export interface QoderActivitySnapshot {
  activities: QoderActivity[];
  queryAt: number;
  fetchedAt: string;
}

export interface ActivityResponse {
  code?: number;
  msg?: string;
  data?: { activities?: QoderActivity[]; queryAt?: number };
}

export async function exchangeJobToken(tokens: QoderTokens): Promise<JobTokenResponse> {
  const inner = {
    personalToken: tokens.personalToken,
    securityOauthToken: tokens.securityOauthToken || "",
    refreshToken: tokens.refreshToken || "",
    needRefresh: !!tokens.refreshToken,
    authInfo: {},
  };
  const outer = { payload: JSON.stringify(inner), encodeVersion: "1" };
  const body = encodeQoderPayload(JSON.stringify(outer));

  const resp = await fetch(JOB_TOKEN_URL, {
    method: "POST",
    headers: signatureHeaders(tokens),
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`jobToken HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  return (await resp.json()) as JobTokenResponse;
}

export function buildIdentity(tokens: QoderTokens): AuthIdentity {
  return {
    name: tokens.userName || "",
    aid: tokens.userId || "",
    uid: tokens.userId || "",
    yx_uid: "",
    organization_id: "",
    organization_name: "",
    user_type: tokens.userType || "personal_standard",
    security_oauth_token: tokens.securityOauthToken || "",
    refresh_token: tokens.refreshToken || "",
  };
}

export interface BearerCallOptions {
  url: string;
  /** Pass `null`/`undefined` for GET-style calls with no body. */
  body?: unknown;
  /** Defaults to "POST". Use "GET" for query-only endpoints (e.g. /activity). */
  method?: "GET" | "POST";
  extraHeaders?: Record<string, string>;
  stream?: boolean;
}

export async function bearerFetch(tokens: QoderTokens, opts: BearerCallOptions): Promise<Response> {
  const method = opts.method || "POST";
  const session = buildSessionContext(buildIdentity(tokens));
  const bodyEncoded = opts.body == null ? "" : encodeQoderPayload(JSON.stringify(opts.body));
  const payloadB64 = buildPayloadB64(session.info);
  const date = String(Math.floor(Date.now() / 1000));
  const pathSig = pathSigFromUrl(opts.url);
  const sig = signBearerRequest(payloadB64, session.cosyKey, date, bodyEncoded, pathSig);

  // Header layout matches qodercli 1.0.22 capture. Notable differences vs the
  // older qoder2api port:
  //   - cosy-data-policy is lowercase "agree" (was "AGREE")
  //   - cosy-machinetype is the literal string "5" (client type indicator),
  //     NOT a random UUID-derived value
  //   - cosy-machinetoken equals cosy-machineid (same UUID)
  //   - cosy-business-product / cosy-business-type / cosy-scene are NEW —
  //     the server uses these to attribute the request to a billing bucket
  //   - the fake link-local cosy-clientip is gone; CLI doesn't send it.
  //   - user-agent is Go-http-client/2.0 (Go binary, unchanged)
  const machineId = tokens.machineId;
  const machineToken = tokens.machineToken || machineId; // CLI: token == id
  const headers: Record<string, string> = {
    "cosy-data-policy": "agree",
    "cosy-machinetype": "5",
    "cosy-clienttype": "5",
    "cosy-date": date,
    "cosy-user": tokens.userId || "",
    "cosy-key": session.cosyKey,
    "cache-control": "no-cache",
    "cosy-business-product": BUSINESS_PRODUCT,
    "cosy-business-type": BUSINESS_TYPE,
    "cosy-scene": COSY_SCENE,
    accept: opts.stream ? "text/event-stream" : "application/json",
    authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "accept-encoding": "identity",
    "cosy-version": COSY_VERSION,
    "cosy-machineid": machineId,
    "cosy-machinetoken": machineToken,
    "login-version": "v2",
    "user-agent": "Go-http-client/2.0",
    ...(opts.extraHeaders || {}),
  };

  // content-type is meaningful only when there's a body to send.
  const init: RequestInit = { method, headers };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    init.body = bodyEncoded;
  }
  return fetch(opts.url, init);
}
