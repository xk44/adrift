import { spawn } from "child_process";
import os from "os";
import packageJson from "../../package.json";
import { configuredBindHost, isLoopbackHostname } from "@/lib/net/bindPolicy";

type BonjourState = {
  initialized: boolean;
  warned: boolean;
};

const globalStore = globalThis as typeof globalThis & {
  __cjBonjour?: BonjourState;
};

function state(): BonjourState {
  return (globalStore.__cjBonjour ??= { initialized: false, warned: false });
}

export function buildBonjourArgs(
  hostname: string,
  version: string,
  port: number,
): string[] {
  return [
    "-R",
    `Adrift (${hostname})`,
    "_cj._tcp",
    "local.",
    String(port),
    `version=${version}`,
    "path=/api/health",
  ];
}

/**
 * Only advertise when other devices can actually connect: the configured bind
 * host (CJ_HOST, or a wildcard HOSTNAME in Docker) is set and not loopback.
 * Unset means the 127.0.0.1 default, so nothing is announced on the LAN.
 */
export function shouldAdvertise(host: string = configuredBindHost()): boolean {
  return !!host && !isLoopbackHostname(host);
}

/**
 * Advertise this server for LAN clients. dns-sd keeps the registration alive
 * for as long as its child process runs, so this must be initialized once.
 */
export function initBonjour(): void {
  const registration = state();
  if (registration.initialized) return;
  registration.initialized = true;

  if (!shouldAdvertise()) return;

  if (process.platform !== "darwin") {
    if (!registration.warned) {
      registration.warned = true;
      console.warn("[adrift] Bonjour advertising is only available on macOS");
    }
    return;
  }

  const warn = (error: unknown) => {
    if (registration.warned) return;
    registration.warned = true;
    console.warn("[adrift] Bonjour advertising unavailable", error);
  };

  try {
    const child = spawn(
      "dns-sd",
      buildBonjourArgs(
        os.hostname(),
        packageJson.version,
        Number.parseInt(process.env.PORT ?? "3000", 10) || 3000,
      ),
      { stdio: "ignore" },
    );

    child.once("error", warn);

    const reap = () => child.kill();
    process.once("exit", reap);
    const onSigterm = () => {
      reap();
      process.removeListener("SIGTERM", onSigterm);
      process.kill(process.pid, "SIGTERM");
    };
    process.once("SIGTERM", onSigterm);
  } catch (error) {
    warn(error);
  }
}
