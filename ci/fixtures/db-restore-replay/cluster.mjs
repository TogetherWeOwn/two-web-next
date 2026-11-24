import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const bin = "/usr/lib/postgresql/18/bin";
export const bootstrap = "fixture_bootstrap";
export const newPassword = () => randomBytes(24).toString("hex");

function pg(command, args) {
  try {
    execFileSync(join(bin, command), args, {
      env: { LANG: "C" },
      stdio: "pipe",
      timeout: 30_000,
    });
  } catch {
    throw new Error(`PostgreSQL fixture command failed: ${command} ${args[0]}`);
  }
}

export function fixtureCluster(directory) {
  mkdirSync(directory, { mode: 0o700 });
  const data = join(directory, "db");
  const passwordFile = join(directory, "bootstrap.pw");
  const password = newPassword();
  writeFileSync(passwordFile, password, { mode: 0o600 });
  try {
    pg("initdb", [
      "--no-locale",
      "--encoding=UTF8",
      "--username",
      bootstrap,
      "--auth=scram-sha-256",
      "--pwfile",
      passwordFile,
      "-D",
      data,
    ]);
  } finally {
    rmSync(passwordFile);
  }
  // No TCP listener and no client-supplied endpoint. The socket is inside a
  // private, newly created directory and both clusters use separate sockets.
  const stop = () => {
    if (existsSync(join(data, "postmaster.pid"))) {
      pg("pg_ctl", ["stop", "-D", data, "-w", "-t", "15", "-m", "immediate"]);
    }
  };
  try {
    pg("pg_ctl", [
      "start",
      "-D",
      data,
      "-w",
      "-t",
      "15",
      "-l",
      join(directory, "server.log"),
      "-o",
      `-c listen_addresses='' -k ${directory} -c log_min_error_statement=panic`,
    ]);
  } catch (error) {
    stop();
    throw error;
  }

  const connect = (user, pass, database = "postgres") =>
    postgres({
      path: join(directory, ".s.PGSQL.5432"),
      database,
      user,
      pass,
      max: 1,
      connect_timeout: 5,
      connection: { statement_timeout: 10_000, lock_timeout: 2_000 },
      onnotice: () => {},
    });

  return {
    connect,
    admin: (database) => connect(bootstrap, password, database),
    stop,
  };
}
