export function buildMacosSeatbeltPolicy(opts: {
  cwd: string;
  allowNetwork: boolean;
}): string {
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "; allow basic process operations",
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow file-read*)",
    "(allow file-read-metadata)",
    "(allow mach-lookup)",
    "(allow ipc-posix-shm)",
    "(allow file-write* (subpath \"/tmp\"))",
    "(allow file-write* (subpath \"/private/tmp\"))",
    "(allow file-write* (subpath \"/var/folders\"))",
    "(allow file-write* (subpath \"/private/var/folders\"))",
    `(allow file-write* (subpath ${jsonString(opts.cwd)}))`,
  ];
  if (opts.allowNetwork) {
    lines.push("(allow network*)");
  } else {
    lines.push("(allow network* (local ip) (local tcp \"localhost:*\"))");
  }
  return lines.join("\n");
}

function jsonString(s: string): string {
  return JSON.stringify(s);
}
