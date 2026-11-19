import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface RegisterClientAppOptions {
  clientDist?: string;
}

export async function registerClientApp(
  app: FastifyInstance,
  { clientDist }: RegisterClientAppOptions = {},
): Promise<boolean> {
  const root = clientDist ?? (process.env.VELVET_CLIENT_DIST || path.join(repoRoot, "client", "dist"));
  const indexFile = path.join(root, "index.html");
  if (!existsSync(indexFile)) return false;

  const indexHtml = await readFile(indexFile);

  await app.register(fastifyStatic, {
    root,
    prefix: "/",
    wildcard: false,
    index: false,
  });

  const sendIndex = (reply: FastifyReply) =>
    reply.header("cache-control", "no-cache").type("text/html").send(indexHtml);

  app.get("/", (_request, reply) => sendIndex(reply));

  app.get("/*", (request, reply) => {
    const pathname = request.url.split("?", 1)[0] ?? "/";
    if (pathname.startsWith("/api/") || pathname.startsWith("/assets/") || path.posix.extname(pathname)) {
      return reply.callNotFound();
    }
    return sendIndex(reply);
  });

  return true;
}
