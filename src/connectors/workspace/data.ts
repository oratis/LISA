import { bound, fail, identifier, row, rows, string, Reader, type Row } from "./http.js";
import type { CloudId } from "./catalog.js";

export interface Resource {
  id: string;
  name: string;
}
export type Account = Resource;
export interface Period {
  from: string;
  to: string;
}
export function resource(id: unknown, name: unknown): Resource {
  return { id: identifier(id), name: string(name, 400) };
}
export function limitedText(text: string) {
  return { text: text.slice(0, 30000), truncated: text.length > 30000 };
}
export function collection(items: unknown[], more: unknown = false) {
  return { items: items.slice(0, 50), truncated: items.length > 50 || Boolean(more) };
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const atom = /^[A-Za-z0-9_!+=:/-]{1,500}$/;
export function validId(provider: CloudId, value: unknown): value is string {
  if (typeof value !== "string") return false;
  const [left, right, ...other] = value.split("|");
  if (other.length) return false;
  if (provider === "figma")
    return (
      /^[a-zA-Z0-9_-]{1,128}$/.test(left!) &&
      (right === undefined || /^\d{1,20}:\d{1,20}$/.test(right))
    );
  if (provider === "todoist") return /^[a-zA-Z0-9_-]{1,128}$/.test(value);
  if (provider === "jira" || provider === "confluence")
    return uuid.test(left!) && /^\d{1,25}$/.test(right ?? "");
  if (provider === "sharepoint") {
    const site = left!.split(",");
    return (
      site.length === 3 &&
      /^[a-z0-9-]+\.sharepoint\.com$/i.test(site[0]!) &&
      uuid.test(site[1]!) &&
      uuid.test(site[2]!) &&
      atom.test(right ?? "")
    );
  }
  if (right !== undefined) return false;
  if (provider === "dropbox") return /^id:[a-zA-Z0-9_-]{1,128}$/.test(value);
  return atom.test(value) && !value.includes("..");
}
const enc = encodeURIComponent;
export async function identity(api: Reader, tenant?: string): Promise<Account> {
  switch (api.vendor) {
    case "todoist": {
      const u = await api.get("/api/v1/user");
      return resource(u.id, u.full_name);
    }
    case "microsoft": {
      const u = await api.get("/v1.0/me", { $select: "id,displayName" });
      return resource(tenant + ":" + identifier(u.id), u.displayName);
    }
    case "atlassian": {
      const u = await api.get("/me");
      return resource(u.account_id, u.name);
    }
    case "figma": {
      const u = await api.get("/v1/me");
      return resource(u.id, u.handle);
    }
    case "dropbox": {
      const u = await api.dropbox("users/get_current_account", null);
      return resource(u.account_id, row(u.name).display_name);
    }
  }
}
export async function choices(id: CloudId, api: Reader): Promise<Resource[]> {
  switch (id) {
    case "todoist":
      return rows((await api.get("/api/v1/projects", { limit: "30" })).results).map((p) =>
        resource(p.id, p.name),
      );
    case "outlook-mail":
      return rows(
        (await api.get("/v1.0/me/mailFolders", { $select: "id,displayName", $top: "30" })).value,
      ).map((p) => resource(p.id, p.displayName));
    case "outlook-calendar":
      return rows(
        (await api.get("/v1.0/me/calendars", { $select: "id,name", $top: "30" })).value,
      ).map((p) => resource(p.id, p.name));
    case "onedrive":
      return rows(
        (
          await api.get("/v1.0/me/drive/root/children", {
            $select: "id,name,file,folder,remoteItem",
            $top: "30",
          })
        ).value,
      )
        .filter((p) => !p.remoteItem && (p.file || p.folder))
        .map((p) => resource(p.id, p.name));
    case "dropbox":
      return rows(
        (await api.dropbox("files/list_folder", { path: "", recursive: false, limit: 30 })).entries,
      )
        .filter((p) => ["folder", "file"].includes(String(p[".tag"])))
        .map((p) => resource(p.id, p.name));
    case "jira":
    case "confluence": {
      const needed = id === "jira" ? "read:jira-work" : "read:page:confluence";
      const sites = (await api.atlassianSites())
        .filter(
          (s) =>
            typeof s.id === "string" &&
            uuid.test(s.id) &&
            Array.isArray(s.scopes) &&
            s.scopes.includes(needed),
        )
        .slice(0, 3);
      const items: Resource[] = [];
      for (const site of sites) {
        const root = "/ex/" + id + "/" + site.id;
        const catalog =
          id === "jira"
            ? await api.get(root + "/rest/api/3/project/search", { maxResults: "30" })
            : await api.get(root + "/wiki/api/v2/pages", { limit: "30" });
        for (const p of rows(id === "jira" ? catalog.values : catalog.results)) {
          const key = site.id + "|" + identifier(p.id);
          if (validId(id, key))
            items.push(
              resource(
                key,
                string(site.name, 120) + " · " + string(id === "jira" ? p.name : p.title, 240),
              ),
            );
        }
        if (items.length >= 30) break;
      }
      return items.slice(0, 30);
    }
    default:
      return []; // These APIs select an explicit project, page, site/file or design key.
  }
}
function graphPath(id: CloudId, key: string) {
  if (id === "sharepoint") {
    const [site, item] = key.split("|");
    return "/v1.0/sites/" + enc(site!) + "/drive/items/" + enc(item!);
  }
  if (id === "onedrive") return "/v1.0/me/drive/items/" + enc(key);
  return "/v1.0/me/" + (id === "outlook-mail" ? "mailFolders/" : "calendars/") + enc(key);
}
function atlasPath(id: CloudId, key: string) {
  const [site, item] = key.split("|");
  return id === "jira"
    ? "/ex/jira/" + site + "/rest/api/3/project/" + item
    : "/ex/confluence/" + site + "/wiki/api/v2/pages/" + item;
}
async function figmaDocument(api: Reader, key: string, depth: string) {
  const [file, node] = key.split("|");
  if (!node) {
    const data = await api.get("/v1/files/" + enc(file!), { depth });
    return { name: string(data.name), document: row(data.document) };
  }
  const data = await api.get("/v1/files/" + enc(file!) + "/nodes", { ids: node, depth });
  const document = row(row(row(data.nodes)[node]).document);
  bound(document.id, node);
  return { name: string(document.name), document };
}
export async function lookup(id: CloudId, api: Reader, key: string): Promise<Resource> {
  if (!validId(id, key)) fail("invalid_resource");
  switch (id) {
    case "todoist": {
      const p = await api.get("/api/v1/projects/" + enc(key));
      bound(p.id, key);
      return resource(key, p.name);
    }
    case "jira":
    case "confluence": {
      const p = await api.get(atlasPath(id, key));
      bound(p.id, key.split("|")[1]!);
      return resource(key, id === "jira" ? p.name : p.title);
    }
    case "figma": {
      const f = await figmaDocument(api, key, "1");
      return resource(key, f.name);
    }
    case "dropbox": {
      const p = await api.dropbox("files/get_metadata", { path: key });
      bound(p.id, key);
      if (!["file", "folder"].includes(String(p[".tag"]))) fail();
      return resource(key, p.name);
    }
    default: {
      const file = id === "onedrive" || id === "sharepoint";
      const p = await api.get(graphPath(id, key), {
        $select: file
          ? "id,name,file,folder,remoteItem,deleted"
          : id === "outlook-mail"
            ? "id,displayName"
            : "id,name",
      });
      bound(p.id, key.split("|").at(-1)!);
      if (file && (p.remoteItem || p.deleted || !(p.file || p.folder)))
        fail("workspace_inaccessible");
      return resource(key, id === "outlook-mail" ? p.displayName : p.name);
    }
  }
}
const textName = (name: unknown) =>
  typeof name === "string" && /\.(txt|md|csv|tsv|json|log|xml|yaml|yml)$/i.test(name);
const label = (v: unknown) => (typeof v === "string" ? v.slice(0, 500) : null);
function dateTime(value: unknown) {
  const d = row(value);
  return { dateTime: label(d.dateTime), timeZone: label(d.timeZone) };
}
function layers(node: Row, depth: number, budget: { left: number; truncated: boolean }): Row[] {
  const output: Row[] = [];
  for (const child of node.children ? rows(node.children) : []) {
    if (budget.left <= 0) {
      budget.truncated = true;
      break;
    }
    budget.left--;
    const entry: Row = { id: label(child.id), name: label(child.name), type: label(child.type) };
    if (typeof child.characters === "string") {
      entry.text = child.characters.slice(0, 500);
      if (child.characters.length > 500) budget.truncated = true;
    }
    if (depth > 1) entry.children = layers(child, depth - 1, budget);
    else if (
      Array.isArray(child.children)
        ? child.children.length > 0
        : [
            "DOCUMENT",
            "CANVAS",
            "FRAME",
            "GROUP",
            "COMPONENT",
            "COMPONENT_SET",
            "INSTANCE",
            "SECTION",
            "BOOLEAN_OPERATION",
          ].includes(String(child.type))
    )
      budget.truncated = true;
    output.push(entry);
  }
  return output;
}
export async function contents(id: CloudId, api: Reader, key: string, period: Period) {
  if (!validId(id, key)) fail("invalid_resource");
  switch (id) {
    case "todoist": {
      const r = await api.get("/api/v1/tasks", { project_id: key, limit: "50" });
      return collection(
        rows(r.results).map((x) => {
          bound(x.project_id, key);
          return {
            id: identifier(x.id),
            title: string(x.content),
            priority: typeof x.priority === "number" ? x.priority : null,
            due: x.due ? label(row(x.due).date) : null,
          };
        }),
        r.next_cursor,
      );
    }
    case "outlook-mail": {
      const r = await api.get(graphPath(id, key) + "/messages", {
        $select: "id,subject,receivedDateTime,isRead,parentFolderId",
        $orderby: "receivedDateTime desc",
        $top: "50",
      });
      return collection(
        rows(r.value).map((x) => {
          bound(x.parentFolderId, key);
          return {
            id: identifier(x.id),
            subject: string(x.subject ?? ""),
            received: label(x.receivedDateTime),
            read: x.isRead === true,
          };
        }),
        r["@odata.nextLink"],
      );
    }
    case "outlook-calendar": {
      const r = await api.get(graphPath(id, key) + "/calendarView", {
        startDateTime: period.from,
        endDateTime: period.to,
        $select: "id,subject,start,end,isAllDay",
        $top: "50",
      });
      return collection(
        rows(r.value).map((x) => ({
          id: identifier(x.id),
          title: string(x.subject ?? ""),
          start: dateTime(x.start),
          end: dateTime(x.end),
          allDay: x.isAllDay === true,
        })),
        r["@odata.nextLink"],
      );
    }
    case "onedrive":
    case "sharepoint": {
      const path = graphPath(id, key),
        expected = key.split("|").at(-1)!;
      const p = await api.get(path);
      bound(p.id, expected);
      if (p.remoteItem || p.deleted) fail("workspace_inaccessible");
      if (p.folder) {
        const r = await api.get(path + "/children", {
          $select: "id,name,size,parentReference,folder,file,remoteItem,deleted",
          $top: "50",
        });
        return collection(
          rows(r.value)
            .filter((x) => !x.remoteItem && !x.deleted)
            .map((x) => {
              bound(row(x.parentReference).id, expected);
              return {
                id: identifier(x.id),
                name: string(x.name),
                kind: x.folder ? "folder" : "file",
              };
            }),
          r["@odata.nextLink"],
        );
      }
      if (!p.file || !textName(p.name) || typeof p.size !== "number" || p.size > 1_000_000)
        fail("workspace_content_unavailable");
      const version = identifier(p.eTag);
      const text = await api.graphText(p["@microsoft.graph.downloadUrl"]);
      const after = await api.get(path, { $select: "id,eTag" });
      bound(after.id, expected);
      bound(after.eTag, version);
      return limitedText(text);
    }
    case "jira": {
      const [site, project] = key.split("|");
      const r = await api.get("/ex/jira/" + site + "/rest/api/3/search/jql", {
        jql: "project = " + project + " ORDER BY updated DESC",
        fields: "project,summary,status",
        maxResults: "50",
      });
      return collection(
        rows(r.issues).map((x) => {
          const f = row(x.fields);
          bound(row(f.project).id, project!);
          return {
            key: string(x.key),
            summary: string(f.summary),
            status: label(row(f.status).name),
          };
        }),
        r.nextPageToken,
      );
    }
    case "confluence": {
      const p = await api.get(atlasPath(id, key), { "body-format": "storage" });
      bound(p.id, key.split("|")[1]!);
      const markup = string(row(row(p.body).storage).value, 1_000_000);
      return { format: "storage", ...limitedText(markup) };
    }
    case "figma": {
      const f = await figmaDocument(api, key, "3");
      const budget = { left: 100, truncated: false };
      return {
        name: string(f.name),
        type: label(f.document.type),
        ...(typeof f.document.characters === "string" ? limitedText(f.document.characters) : {}),
        layers: layers(f.document, 3, budget),
        truncated:
          budget.truncated ||
          (typeof f.document.characters === "string" && f.document.characters.length > 30000),
      };
    }
    case "dropbox": {
      const file = await api.dropbox("files/get_metadata", { path: key });
      bound(file.id, key);
      if (file[".tag"] === "folder") {
        const r = await api.dropbox("files/list_folder", {
          path: key,
          recursive: false,
          limit: 50,
        });
        const parent = string(file.path_lower, 4096);
        return collection(
          rows(r.entries).map((x) => {
            const path = string(x.path_lower, 4096);
            bound(path.slice(0, path.lastIndexOf("/")), parent);
            return { id: identifier(x.id), name: string(x.name), kind: label(x[".tag"]) };
          }),
          r.has_more,
        );
      }
      if (
        file[".tag"] !== "file" ||
        !textName(file.name) ||
        typeof file.size !== "number" ||
        file.size > 1_000_000
      )
        fail("workspace_content_unavailable");
      const rev = identifier(file.rev),
        text = await api.dropboxText(key);
      const after = await api.dropbox("files/get_metadata", { path: key });
      bound(after.id, key);
      bound(after.rev, rev);
      return limitedText(text);
    }
  }
}
