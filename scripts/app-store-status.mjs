// Read-only status for the existing Pocket app. Never print JWTs, keys or review credentials.
import crypto from "node:crypto";
import fs from "node:fs/promises";
const APP = "6784690058";
const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_API_KEY_BASE64, BUILD_NUMBER } = process.env;
if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_API_KEY_BASE64)
  throw Error("App Store API credentials missing");
if (BUILD_NUMBER && !/^\d{1,20}$/.test(BUILD_NUMBER)) throw Error("Invalid build number");
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const message =
  encode({ alg: "ES256", kid: ASC_KEY_ID, typ: "JWT" }) +
  "." +
  encode({
    iss: ASC_ISSUER_ID,
    iat: now,
    exp: now + 300,
    aud: "appstoreconnect-v1",
  });
const signature = crypto
  .sign("sha256", Buffer.from(message), {
    key: crypto.createPrivateKey(Buffer.from(ASC_API_KEY_BASE64, "base64")),
    dsaEncoding: "ieee-p1363",
  })
  .toString("base64url");
async function get(route, query = {}) {
  const url = new URL(route, "https://api.appstoreconnect.apple.com");
  url.search = new URLSearchParams(query).toString();
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + message + "." + signature },
    redirect: "error",
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw Error(`App Store status request failed: HTTP ${response.status}`);
  return response.json();
}
const [builds, versions] = await Promise.all([
  get("/v1/builds", {
    "filter[app]": APP,
    ...(BUILD_NUMBER ? { "filter[version]": BUILD_NUMBER } : {}),
    sort: "-uploadedDate",
    limit: "10",
    "fields[builds]": "version,uploadedDate,processingState,expired,usesNonExemptEncryption",
  }),
  get(`/v1/apps/${APP}/appStoreVersions`, {
    "filter[platform]": "IOS",
    limit: "20",
    "fields[appStoreVersions]": "versionString,appVersionState,releaseType",
  }),
]);
const report = {
  checkedAt: new Date().toISOString(),
  app: APP,
  builds: builds.data.map(({ id, attributes: a }) => ({
    id,
    number: a.version,
    uploadedAt: a.uploadedDate,
    processingState: a.processingState,
    expired: a.expired,
    usesNonExemptEncryption: a.usesNonExemptEncryption,
  })),
  versions: versions.data.map(({ id, attributes: a }) => ({
    id,
    version: a.versionString,
    state: a.appVersionState,
    releaseType: a.releaseType,
  })),
};
const output = JSON.stringify(report, null, 2);
console.log(output);
await fs.writeFile("app-store-status.json", output + "\n");
if (process.env.GITHUB_STEP_SUMMARY)
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, "```json\n" + output + "\n```\n");
